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
import type { Store } from './db.ts'
import type { Predictor } from './predict.ts'
import type { Tracker } from './tracker.ts'
import { matchesWidget, queueWidget, rolesWidget, streakAlert, type WidgetContent } from './widgets.ts'

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
} as const

const STREAK_ROLE_BUTTON = 'tracklatro:role:streak'
const DEFAULT_STREAK_MIN = 5
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
      .setDescription('A role picker (win-streak alerts)')
      .addChannelOption(channelOption('Channel for the role picker'))
      .addRoleOption((o) => o.setName('streak_role').setDescription('Role for win-streak alerts').setRequired(true))
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
            { name: 'Win-streak pings', value: 'streak' }
          )
      )
  )
  .addSubcommand((s) => s.setName('show').setDescription('Show the current setup'))

type WidgetKind = 'matches' | 'queue'

/**
 * Per-server channels on top of the DMs and the live feed:
 *  - self-updating "ongoing matches" and "in queue" widgets
 *  - a results channel (finished matches with their results)
 *  - a role picker (win-streak alerts) and win-streak pings
 * Configured with /setup and stored in the database.
 */
export class ServerFeatures {
  readonly #client: Client
  readonly #store: Store
  readonly #tracker: Tracker
  readonly #predictor: Predictor
  readonly #label: (id: string) => string
  readonly #named: (ids: Iterable<string>) => Promise<void>
  /** Last rendered widget content, to only edit on change. */
  readonly #lastRender = new Map<WidgetKind, string>()
  /** Streak each player was last pinged for: one ping per streak, not per requeue. */
  readonly #pingedStreak = new Map<string, number>()
  #flushTimer: NodeJS.Timeout | undefined
  #lastFlush = 0
  #flushing = false

  constructor(opts: {
    client: Client
    store: Store
    tracker: Tracker
    predictor: Predictor
    label: (id: string) => string
    named: (ids: Iterable<string>) => Promise<void>
  }) {
    this.#client = opts.client
    this.#store = opts.store
    this.#tracker = opts.tracker
    this.#predictor = opts.predictor
    this.#label = opts.label
    this.#named = opts.named
    for (const e of ['queue_join', 'queue_leave', 'match_start', 'match_end', 'round'] as const) {
      this.#tracker.on(e, () => this.#markDirty())
    }
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

  // ------------------------------------------------------------ streak pings

  async onQueueJoin(playerId: string) {
    const roleId = this.#store.getSetting(S.streakRole)
    const channel = await this.#channel(this.#store.getSetting(S.streakChannel))
    if (!roleId || !channel) return
    const min = Number(this.#store.getSetting(S.streakMin) ?? DEFAULT_STREAK_MIN)
    const streak = this.#tracker.players.get(playerId)?.streak ?? 0
    if (streak < min || this.#pingedStreak.get(playerId) === streak) return
    this.#pingedStreak.set(playerId, streak)
    await this.#named([playerId])
    await channel
      .send({ content: streakAlert(this.#label(playerId), streak, roleId), allowedMentions: { roles: [roleId] } })
      .catch((err) => warn('streak ping', err))
  }

  // -------------------------------------------------------------- role picker

  async #postRolesWidget() {
    const content = rolesWidget(
      this.#store.getSetting(S.streakChannel),
      Number(this.#store.getSetting(S.streakMin) ?? DEFAULT_STREAK_MIN)
    )
    const embed = new EmbedBuilder()
      .setTitle(content.title)
      .setDescription(content.description)
      .setFooter({ text: content.footer })
      .setColor(0xe67e22)
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(STREAK_ROLE_BUTTON)
        .setLabel('Win-streak alerts')
        .setEmoji('🔥')
        .setStyle(ButtonStyle.Secondary)
    )
    await this.#upsert(S.rolesChannel, S.rolesMessage, { embeds: [embed], components: [row] })
  }

  /** Returns true if this was one of our buttons. */
  async handleButton(i: ButtonInteraction): Promise<boolean> {
    if (i.customId !== STREAK_ROLE_BUTTON) return false
    const roleId = this.#store.getSetting(S.streakRole)
    if (!i.inCachedGuild() || !roleId) {
      await i.reply({ content: 'This role picker is no longer set up.', flags: MessageFlags.Ephemeral })
      return true
    }
    const has = i.member.roles.cache.has(roleId)
    try {
      if (has) await i.member.roles.remove(roleId, 'tracklatro role picker')
      else await i.member.roles.add(roleId, 'tracklatro role picker')
      await i.reply({
        content: has ? `Removed <@&${roleId}>.` : `Added <@&${roleId}>. You'll be pinged for win streaks.`,
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

    if (sub === 'show') {
      const ch = (key: string) => (this.#store.getSetting(key) ? `<#${this.#store.getSetting(key)}>` : '—')
      const role = this.#store.getSetting(S.streakRole)
      return reply(
        [
          `**Ongoing matches widget:** ${ch(S.matchesChannel)}`,
          `**Queue widget:** ${ch(S.queueChannel)}`,
          `**Results:** ${ch(S.resultsChannel)}`,
          `**Role picker:** ${ch(S.rolesChannel)} · role ${role ? `<@&${role}>` : '—'}`,
          `**Win-streak pings:** ${ch(S.streakChannel)} · min ${this.#store.getSetting(S.streakMin) ?? DEFAULT_STREAK_MIN}`,
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
      } else if (feature === 'streak') {
        this.#store.deleteSetting(S.streakChannel)
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
      const role = i.options.getRole('streak_role', true)
      const problem = roleProblem(role, i.guild.members.me!)
      if (problem) return reply(problem)
      await this.#deleteMessage(S.rolesChannel, S.rolesMessage)
      this.#store.setSetting(S.rolesChannel, channel.id)
      this.#store.setSetting(S.streakRole, role.id)
      await this.#postRolesWidget()
      return reply(`Role picker posted in ${channel} for ${role}.`)
    }

    if (sub === 'streak') {
      const role = this.#store.getSetting(S.streakRole)
      if (!role) return reply('Set up the role first: `/setup roles`.')
      this.#store.setSetting(S.streakChannel, channel.id)
      this.#store.setSetting(S.streakMin, String(i.options.getInteger('min_streak') ?? DEFAULT_STREAK_MIN))
      await this.#refreshRolesWidget()
      const mentionable = i.guild.roles.cache.get(role)?.mentionable
      return reply(
        `<@&${role}> will be pinged in ${channel} when someone on a ${this.#store.getSetting(S.streakMin)}+ win streak queues.` +
          (mentionable ? '' : '\n⚠️ That role isn\'t mentionable: turn on **Allow anyone to @mention this role** (or give me **Mention Everyone**), or the pings won\'t notify anyone.')
      )
    }
  }

  async #refreshRolesWidget() {
    if (this.#store.getSetting(S.rolesChannel)) await this.#postRolesWidget().catch((err) => warn('roles widget', err))
  }
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
