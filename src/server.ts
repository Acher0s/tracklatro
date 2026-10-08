import {
  ActionRowBuilder,
  ApplicationIntegrationType,
  type ButtonInteraction,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  type ChatInputCommandInteraction,
  type Client,
  DiscordAPIError,
  EmbedBuilder,
  type GuildMember,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  type Role,
  type SendableChannels,
  SlashCommandBuilder,
  type SlashCommandChannelOption,
} from 'discord.js'
import type { Config } from './config.ts'
import type { Store } from './db.ts'
import { applySpeed, describeSpeed, isSpeed } from './speed.ts'
import type { Predictor } from './predict.ts'
import type { Tracker } from './tracker.ts'
import type { MatchOutcome, TrackedMatch } from './tracker.ts'
import {
  matchesWidget,
  queueWidget,
  type RoleAlerts,
  rolesWidget,
  streakAlert,
  tiltAlert,
  tiltChain,
  type WidgetContent,
} from './widgets.ts'

const S = {
  matchesChannel: 'matches_channel',
  matchesMessage: 'matches_message',
  queueChannel: 'queue_channel',
  queueMessage: 'queue_message',
  resultsChannel: 'results_channel',
  rolesChannel: 'roles_channel',
  rolesMessage: 'roles_message',
  streakRole: 'streak_role',
  streakChannel: 'streak_channel',
  streakMin: 'streak_min',
  tiltRole: 'tilt_role',
  tiltChannel: 'tilt_channel',
  tiltMin: 'tilt_min',
  tiltWindow: 'tilt_window_minutes',
  pollSpeed: 'poll_speed',
} as const

/** Role picker buttons → the setting holding their role. */
const ROLE_BUTTONS: Record<string, string> = {
  'tracklatro:role:streak': S.streakRole,
  'tracklatro:role:tilt': S.tiltRole,
}
const DEFAULT_STREAK_MIN = 5
const DEFAULT_TILT_MIN = 2
const DEFAULT_TILT_WINDOW_MINUTES = 10
/** Widgets are edited at most this often, and only when their content changed. */
const WIDGET_MIN_INTERVAL_MS = 10_000
/** Totals in widget footers (one site request) may be this old. */
const WIDGET_COUNTS_MAX_AGE_MS = 60_000

const channelOption = (description: string) => (o: SlashCommandChannelOption) =>
  o
    .setName('channel')
    .setDescription(description)
    .setRequired(true)
    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)

export const SETUP_COMMAND = new SlashCommandBuilder()
  .setName('setup')
  .setDescription('Set up tracklatro channels for this server')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((s) =>
    s
      .setName('matches')
      .setDescription('A self-updating list of ongoing matches')
      .addChannelOption(channelOption('Channel for the widget'))
  )
  .addSubcommand((s) =>
    s
      .setName('queue')
      .setDescription('A self-updating list of players in queue')
      .addChannelOption(channelOption('Channel for the widget'))
  )
  .addSubcommand((s) =>
    s
      .setName('results')
      .setDescription('Post finished matches and their results')
      .addChannelOption(channelOption('Channel for results'))
  )
  .addSubcommand((s) =>
    s
      .setName('roles')
      .setDescription('A role picker for alert roles (give at least one role)')
      .addChannelOption(channelOption('Channel for the role picker'))
      .addRoleOption((o) => o.setName('streak_role').setDescription('Role for win-streak alerts'))
      .addRoleOption((o) => o.setName('tilt_role').setDescription('Role for tilt-queue alerts'))
  )
  .addSubcommand((s) =>
    s
      .setName('tilt')
      .setDescription('Ping the tilt-queue role when someone on a losing streak queues right back up')
      .addChannelOption(channelOption('Channel for the pings'))
      .addIntegerOption((o) =>
        o
          .setName('min_losses')
          .setDescription(`Losses in a row (default ${DEFAULT_TILT_MIN})`)
          .setMinValue(2)
          .setMaxValue(20)
      )
      .addIntegerOption((o) =>
        o
          .setName('window_minutes')
          .setDescription(`Max minutes between a loss and the next queue (default ${DEFAULT_TILT_WINDOW_MINUTES})`)
          .setMinValue(1)
          .setMaxValue(60)
      )
  )
  .addSubcommand((s) =>
    s
      .setName('streak')
      .setDescription('Ping the win-streak role when someone on a win streak queues')
      .addChannelOption(channelOption('Channel for the pings'))
      .addIntegerOption((o) =>
        o
          .setName('min_streak')
          .setDescription(`Minimum win streak (default ${DEFAULT_STREAK_MIN})`)
          .setMinValue(2)
          .setMaxValue(50)
      )
  )
  .addSubcommand((s) =>
    s
      .setName('disable')
      .setDescription('Turn a feature off')
      .addStringOption((o) =>
        o
          .setName('feature')
          .setDescription('Feature to turn off')
          .setRequired(true)
          .addChoices(
            { name: 'Ongoing matches widget', value: 'matches' },
            { name: 'Queue widget', value: 'queue' },
            { name: 'Results channel', value: 'results' },
            { name: 'Role picker', value: 'roles' },
            { name: 'Win-streak pings', value: 'streak' },
            { name: 'Tilt-queue pings', value: 'tilt' }
          )
      )
  )
  .addSubcommand((s) =>
    s
      .setName('speed')
      .setDescription('How often the bot checks for queues and matches (faster = more requests to the site)')
      .addStringOption((o) =>
        o
          .setName('speed')
          .setDescription('Polling speed')
          .setRequired(true)
          .addChoices(
            { name: 'eco: every 20s / 60s idle (fewest requests)', value: 'eco' },
            { name: 'normal: every 10s / 30s idle (.env defaults)', value: 'normal' },
            { name: 'fast: every 5s / 10s idle (quickest notifications)', value: 'fast' }
          )
      )
  )
  .addSubcommand((s) => s.setName('show').setDescription('Show the current setup'))

type WidgetKind = 'matches' | 'queue'

/**
 * Per-server channels on top of the DMs and the live feed:
 *  - self-updating "ongoing matches" and "in queue" widgets
 *  - a results channel (finished matches with their results)
 *  - a role picker, plus role pings for win streaks and tilt queues
 * Configured with /setup and stored in the database.
 */
export class ServerFeatures {
  readonly #client: Client
  readonly #config: Config
  readonly #store: Store
  readonly #tracker: Tracker
  readonly #predictor: Predictor
  readonly #label: (id: string) => string
  readonly #named: (ids: Iterable<string>) => Promise<void>
  /** Last rendered widget content, to only edit on change. */
  readonly #lastRender = new Map<WidgetKind, string>()
  /** Streak each player was last pinged for, per alert: one ping per streak, not per requeue. */
  readonly #pinged = new Map<string, number>()
  #flushTimer: NodeJS.Timeout | undefined
  #lastFlush = 0
  #flushing = false

  constructor(opts: {
    client: Client
    config: Config
    store: Store
    tracker: Tracker
    predictor: Predictor
    label: (id: string) => string
    named: (ids: Iterable<string>) => Promise<void>
  }) {
    this.#client = opts.client
    this.#config = opts.config
    this.#store = opts.store
    this.#tracker = opts.tracker
    this.#predictor = opts.predictor
    this.#label = opts.label
    this.#named = opts.named
    for (const e of ['queue_join', 'queue_leave', 'match_start', 'match_end', 'round'] as const) {
      this.#tracker.on(e, () => this.#markDirty())
    }
    this.#tracker.on('match_result', (m, outcome) => void this.#onMatchResult(m, outcome))
  }

  /** On login: bring the widgets up to date (re-posting any that were deleted). */
  async onReady() {
    this.#lastRender.clear()
    if (this.#store.getSetting(S.rolesChannel)) await this.#postRolesWidget().catch((err) => warn('roles widget', err))
    this.#markDirty()
  }

  stop() {
    if (this.#flushTimer) clearTimeout(this.#flushTimer)
  }

  // ------------------------------------------------------------------ widgets

  #markDirty() {
    if (this.#flushTimer) return
    const wait = Math.max(1_000, this.#lastFlush + WIDGET_MIN_INTERVAL_MS - Date.now())
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = undefined
      void this.#flush()
    }, wait)
  }

  async #flush() {
    if (this.#flushing) return this.#markDirty()
    const kinds = (['matches', 'queue'] as const).filter((k) => this.#store.getSetting(channelKey(k)))
    if (!kinds.length) return
    this.#flushing = true
    this.#lastFlush = Date.now()
    try {
      const matches = [...this.#tracker.activeMatches]
      const queuers = [...this.#tracker.players.values()]
        .filter((p) => p.snapshot?.kind === 'queuing')
        .map((p) => ({ id: p.id, since: p.snapshot?.kind === 'queuing' ? p.snapshot.since : 0 }))
      await this.#named([...matches.flatMap((m) => m.players), ...queuers.map((q) => q.id)])
      const counts = await this.#predictor.queueCounts(WIDGET_COUNTS_MAX_AGE_MS)
      for (const kind of kinds) {
        const content =
          kind === 'matches'
            ? matchesWidget(matches, this.#label, counts?.running)
            : queueWidget(queuers, this.#label, counts?.queued)
        await this.#updateWidget(kind, content).catch((err) => warn(`${kind} widget`, err))
      }
    } finally {
      this.#flushing = false
    }
  }

  async #updateWidget(kind: WidgetKind, content: WidgetContent) {
    const key = JSON.stringify(content)
    if (this.#lastRender.get(kind) === key) return
    const embed = new EmbedBuilder()
      .setTitle(content.title)
      .setDescription(content.description)
      .setFooter({ text: content.footer })
      .setColor(kind === 'matches' ? 0xf1c40f : 0x2ecc71)
      .setTimestamp()
    await this.#upsert(channelKey(kind), messageKey(kind), { embeds: [embed] })
    this.#lastRender.set(kind, key)
  }

  /** Edits the stored message, or posts a new one if there isn't one (or it was deleted). */
  async #upsert(channelSetting: string, messageSetting: string, payload: { embeds: EmbedBuilder[]; components?: ActionRowBuilder<ButtonBuilder>[] }) {
    const channel = await this.#channel(this.#store.getSetting(channelSetting))
    if (!channel) return
    const messageId = this.#store.getSetting(messageSetting)
    if (messageId) {
      try {
        await channel.messages.edit(messageId, { ...payload, allowedMentions: { parse: [] } })
        return
      } catch (err) {
        if (!(err instanceof DiscordAPIError && err.code === 10008)) throw err // 10008: unknown message
      }
    }
    const message = await channel.send({ ...payload, allowedMentions: { parse: [] } })
    this.#store.setSetting(messageSetting, message.id)
  }

  async #channel(id: string | undefined): Promise<SendableChannels | undefined> {
    if (!id) return undefined
    const channel = await this.#client.channels.fetch(id).catch(() => null)
    return channel?.isSendable() ? channel : undefined
  }

  async #deleteMessage(channelSetting: string, messageSetting: string) {
    const messageId = this.#store.getSetting(messageSetting)
    this.#store.deleteSetting(messageSetting)
    const channel = await this.#channel(this.#store.getSetting(channelSetting))
    if (messageId && channel) await channel.messages.delete(messageId).catch(() => {})
  }

  // ------------------------------------------------------------------ results

  /** A finished match with its result, for the results channel. */
  async postResult(content: string) {
    const channel = await this.#channel(this.#store.getSetting(S.resultsChannel))
    if (channel) await channel.send({ content, allowedMentions: { parse: [] } }).catch((err) => warn('results post', err))
  }

  // -------------------------------------------------------------- role pings

  async onQueueJoin(playerId: string, since: number) {
    const streak = this.#tracker.players.get(playerId)?.streak ?? 0
    if (streak >= this.#streakMin()) await this.#ping('streak', playerId, streak, streak)
    // The losing result(s) may already be in: check right away.
    await this.#checkTilt(playerId, since)
  }

  /**
   * A requeue straight after a loss is usually seen together with the match
   * end, before the result is known; once it is, check whether that made it a
   * tilt queue.
   */
  async #onMatchResult(m: TrackedMatch, outcome: MatchOutcome) {
    if (outcome.status !== 'found') return
    const loser = outcome.result.won ? m.players[1] : m.players[0]
    const snapshot = this.#tracker.players.get(loser)?.snapshot
    if (snapshot?.kind === 'queuing') await this.#checkTilt(loser, snapshot.since)
  }

  async #checkTilt(playerId: string, queuedAt: number) {
    const games = this.#tracker.players.get(playerId)?.recentGames ?? []
    const losses = tiltChain(games, queuedAt, this.#tiltWindowMs())
    // Keyed by the last loss, so one losing chain pings once.
    if (losses >= this.#tiltMin()) await this.#ping('tilt', playerId, games.at(-1)!.endedAt, losses)
  }

  /** Pings an alert role about a player, once per `dedupe` value (a streak, a loss). */
  async #ping(kind: 'streak' | 'tilt', playerId: string, dedupe: number, count: number) {
    const roleId = this.#store.getSetting(kind === 'streak' ? S.streakRole : S.tiltRole)
    const channel = await this.#channel(this.#store.getSetting(kind === 'streak' ? S.streakChannel : S.tiltChannel))
    const key = `${kind}:${playerId}`
    if (!roleId || !channel || this.#pinged.get(key) === dedupe) return
    this.#pinged.set(key, dedupe)
    await this.#named([playerId])
    const label = this.#label(playerId)
    const content = kind === 'streak' ? streakAlert(label, count, roleId) : tiltAlert(label, count, roleId)
    await channel.send({ content, allowedMentions: { roles: [roleId] } }).catch((err) => warn(`${kind} ping`, err))
  }

  #streakMin(): number {
    return Number(this.#store.getSetting(S.streakMin) ?? DEFAULT_STREAK_MIN)
  }

  #tiltMin(): number {
    return Number(this.#store.getSetting(S.tiltMin) ?? DEFAULT_TILT_MIN)
  }

  #tiltWindowMs(): number {
    return Number(this.#store.getSetting(S.tiltWindow) ?? DEFAULT_TILT_WINDOW_MINUTES) * 60_000
  }

  // -------------------------------------------------------------- role picker

  async #postRolesWidget() {
    const alerts: RoleAlerts = {}
    const buttons: ButtonBuilder[] = []
    if (this.#store.getSetting(S.streakRole)) {
      alerts.streak = { channelId: this.#store.getSetting(S.streakChannel), minStreak: this.#streakMin() }
      buttons.push(roleButton('tracklatro:role:streak', 'Win-streak alerts', '🔥'))
    }
    if (this.#store.getSetting(S.tiltRole)) {
      alerts.tilt = { channelId: this.#store.getSetting(S.tiltChannel), minLosses: this.#tiltMin() }
      buttons.push(roleButton('tracklatro:role:tilt', 'Tilt-queue alerts', '😤'))
    }
    const content = rolesWidget(alerts)
    const embed = new EmbedBuilder()
      .setTitle(content.title)
      .setDescription(content.description)
      .setFooter({ text: content.footer })
      .setColor(0xe67e22)
    const components = buttons.length ? [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)] : []
    await this.#upsert(S.rolesChannel, S.rolesMessage, { embeds: [embed], components })
  }

  /** Returns true if this was one of our buttons. */
  async handleButton(i: ButtonInteraction): Promise<boolean> {
    const setting = ROLE_BUTTONS[i.customId]
    if (!setting) return false
    const roleId = this.#store.getSetting(setting)
    if (!i.inCachedGuild() || !roleId) {
      await i.reply({ content: 'This role picker is no longer set up.', flags: MessageFlags.Ephemeral })
      return true
    }
    const has = i.member.roles.cache.has(roleId)
    try {
      if (has) await i.member.roles.remove(roleId, 'tracklatro role picker')
      else await i.member.roles.add(roleId, 'tracklatro role picker')
      await i.reply({
        content: has ? `Removed <@&${roleId}>.` : `Added <@&${roleId}>. Click again to remove it.`,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      })
    } catch (err) {
      warn('role toggle', err)
      await i.reply({
        content: "I couldn't change your roles. An admin needs to give me **Manage Roles** and put my role above that one.",
        flags: MessageFlags.Ephemeral,
      })
    }
    return true
  }

  // -------------------------------------------------------------------- setup

  async handleSetup(i: ChatInputCommandInteraction) {
    if (!i.inCachedGuild()) return i.reply({ content: 'Use this in a server.', flags: MessageFlags.Ephemeral })
    const reply = (content: string) => i.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } })
    const sub = i.options.getSubcommand()

    if (sub === 'speed') {
      const speed = i.options.getString('speed', true)
      if (!isSpeed(speed)) return reply('Unknown speed.')
      applySpeed(this.#config, speed)
      this.#store.setSetting(S.pollSpeed, speed)
      return reply(`Polling speed set to ${describeSpeed(this.#config, speed)}.`)
    }

    if (sub === 'show') {
      const ch = (key: string) => (this.#store.getSetting(key) ? `<#${this.#store.getSetting(key)}>` : '—')
      const role = (key: string) => (this.#store.getSetting(key) ? `<@&${this.#store.getSetting(key)}>` : '—')
      return reply(
        [
          `**Ongoing matches widget:** ${ch(S.matchesChannel)}`,
          `**Queue widget:** ${ch(S.queueChannel)}`,
          `**Results:** ${ch(S.resultsChannel)}`,
          `**Role picker:** ${ch(S.rolesChannel)}`,
          `**Win-streak pings:** ${ch(S.streakChannel)} · ${role(S.streakRole)} · ${this.#streakMin()}+ wins`,
          `**Tilt-queue pings:** ${ch(S.tiltChannel)} · ${role(S.tiltRole)} · ${this.#tiltMin()}+ losses, requeued within ${this.#tiltWindowMs() / 60_000} min`,
          `**Polling speed:** ${describeSpeed(this.#config, this.#config.speed)}`,
        ].join('\n')
      )
    }

    if (sub === 'disable') {
      const feature = i.options.getString('feature', true)
      if (feature === 'matches' || feature === 'queue') {
        await this.#deleteMessage(channelKey(feature), messageKey(feature))
        this.#store.deleteSetting(channelKey(feature))
        this.#lastRender.delete(feature)
      } else if (feature === 'results') {
        this.#store.deleteSetting(S.resultsChannel)
      } else if (feature === 'roles') {
        await this.#deleteMessage(S.rolesChannel, S.rolesMessage)
        this.#store.deleteSetting(S.rolesChannel)
      } else if (feature === 'streak' || feature === 'tilt') {
        this.#store.deleteSetting(feature === 'streak' ? S.streakChannel : S.tiltChannel)
        await this.#refreshRolesWidget()
      }
      return reply(`Turned off: **${feature}**.`)
    }

    const channel = i.options.getChannel('channel', true, [ChannelType.GuildText, ChannelType.GuildAnnouncement])
    if (!channel.permissionsFor(i.guild.members.me!)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
      return reply(`I need **View Channel**, **Send Messages** and **Embed Links** in ${channel}.`)
    }

    if (sub === 'matches' || sub === 'queue') {
      await this.#deleteMessage(channelKey(sub), messageKey(sub))
      this.#store.setSetting(channelKey(sub), channel.id)
      this.#lastRender.delete(sub)
      await reply(`The ${sub === 'matches' ? 'ongoing matches' : 'queue'} widget will appear in ${channel} in a few seconds.`)
      this.#markDirty()
      return
    }

    if (sub === 'results') {
      this.#store.setSetting(S.resultsChannel, channel.id)
      return reply(`Finished matches and their results will be posted in ${channel}.`)
    }

    if (sub === 'roles') {
      // Roles not given keep their current setting, so either can be added later.
      const streakRole = i.options.getRole('streak_role')
      const tiltRole = i.options.getRole('tilt_role')
      if (!streakRole && !tiltRole && !this.#store.getSetting(S.streakRole) && !this.#store.getSetting(S.tiltRole)) {
        return reply('Give at least one role: `streak_role` and/or `tilt_role`.')
      }
      for (const role of [streakRole, tiltRole]) {
        const problem = role && roleProblem(role, i.guild.members.me!)
        if (problem) return reply(problem)
      }
      await this.#deleteMessage(S.rolesChannel, S.rolesMessage)
      this.#store.setSetting(S.rolesChannel, channel.id)
      if (streakRole) this.#store.setSetting(S.streakRole, streakRole.id)
      if (tiltRole) this.#store.setSetting(S.tiltRole, tiltRole.id)
      await this.#postRolesWidget()
      return reply(`Role picker posted in ${channel}.`)
    }

    if (sub === 'streak' || sub === 'tilt') {
      const role = this.#store.getSetting(sub === 'streak' ? S.streakRole : S.tiltRole)
      if (!role) return reply(`Set up the role first: \`/setup roles ${sub}_role:…\`.`)
      let what: string
      if (sub === 'streak') {
        this.#store.setSetting(S.streakChannel, channel.id)
        this.#store.setSetting(S.streakMin, String(i.options.getInteger('min_streak') ?? DEFAULT_STREAK_MIN))
        what = `someone on a ${this.#streakMin()}+ win streak queues`
      } else {
        this.#store.setSetting(S.tiltChannel, channel.id)
        this.#store.setSetting(S.tiltMin, String(i.options.getInteger('min_losses') ?? DEFAULT_TILT_MIN))
        this.#store.setSetting(S.tiltWindow, String(i.options.getInteger('window_minutes') ?? DEFAULT_TILT_WINDOW_MINUTES))
        what = `someone loses ${this.#tiltMin()}+ games back to back and keeps requeuing (each time within ${this.#tiltWindowMs() / 60_000} min)`
      }
      await this.#refreshRolesWidget()
      const mentionable = i.guild.roles.cache.get(role)?.mentionable
      return reply(
        `<@&${role}> will be pinged in ${channel} when ${what}.` +
          (mentionable
            ? ''
            : "\n⚠️ That role isn't mentionable: turn on **Allow anyone to @mention this role** (or give me **Mention Everyone**), or the pings won't notify anyone.")
      )
    }
  }

  async #refreshRolesWidget() {
    if (this.#store.getSetting(S.rolesChannel)) await this.#postRolesWidget().catch((err) => warn('roles widget', err))
  }
}

function roleButton(customId: string, label: string, emoji: string): ButtonBuilder {
  return new ButtonBuilder().setCustomId(customId).setLabel(label).setEmoji(emoji).setStyle(ButtonStyle.Secondary)
}

function channelKey(kind: WidgetKind): string {
  return kind === 'matches' ? S.matchesChannel : S.queueChannel
}

function messageKey(kind: WidgetKind): string {
  return kind === 'matches' ? S.matchesMessage : S.queueMessage
}

/** Why the bot couldn't hand out this role, if it can't. */
function roleProblem(role: Role, me: GuildMember): string | undefined {
  if (role.managed || role.id === role.guild.id) return `${role} is managed by Discord or an integration; pick a normal role.`
  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) return 'I need the **Manage Roles** permission to hand out roles.'
  if (me.roles.highest.comparePositionTo(role) <= 0) return `Move my role above ${role} in Server Settings → Roles, so I can hand it out.`
  return undefined
}

function warn(what: string, err: unknown) {
  console.warn(`[server] ${what} failed:`, err instanceof Error ? err.message : err)
}
