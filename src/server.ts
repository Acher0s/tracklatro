import {
  ActionRowBuilder,
  AttachmentBuilder,
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
import type { Api, Popularity } from './api.ts'
import { busiestHoursSvg, popularitySvg, renderPng } from './charts.ts'
import type { Predictor } from './predict.ts'
import type { ResultSource } from './results.ts'
import { applySpeed, describeSpeed, isSpeed } from './speed.ts'
import { hourOfDay } from './stats.ts'
import type { Tracker } from './tracker.ts'
import type { MatchOutcome, TrackedMatch } from './tracker.ts'
import {
  activitySummary,
  matchesWidget,
  popularityFromCounts,
  queueWidget,
  type RoleAlerts,
  rolesWidget,
  rangeLabel,
  streakAlert,
  type TiltRole,
  tiltAlert,
  tiltChain,
  tiltRolesFor,
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
  /** Before MMR ranges: a single tilt role (migrated into tiltRoles on first use). */
  tiltRole: 'tilt_role',
  /** JSON TiltRole[]: tilt alert roles, each with an optional MMR range. */
  tiltRoles: 'tilt_roles',
  tiltChannel: 'tilt_channel',
  tiltMin: 'tilt_min',
  tiltWindow: 'tilt_window_minutes',
  pollSpeed: 'poll_speed',
  activityChannel: 'activity_channel',
  activityMessage: 'activity_message',
  metaChannel: 'meta_channel',
  metaMessage: 'meta_message',
} as const

const ACTIVITY_REFRESH_MS = 10 * 60_000
const META_REFRESH_MS = 60 * 60_000
/** When the site's popularity stats fail, wait this long before asking again (they're expensive for it). */
const SITE_META_RETRY_MS = 6 * 3_600_000
const C_BLURPLE = 0x5865f2

/** "Yellow Deck" / "yellow" / "Cocktail Deck ~ …" → "yellow" / "cocktail"; "Spectral+ Stake" → "spectral+". */
export function pickName(raw: string): string {
  return raw
    .replace(/\s*~.*$/, '')
    .replace(/\s+(deck|stake)$/i, '')
    .trim()
    .toLowerCase()
}

/** Adds up counts whose names normalise to the same deck/stake. */
function mergeCounts(counts: Array<{ name: string; games: number }>): Array<{ name: string; games: number }> {
  const merged = new Map<string, number>()
  for (const c of counts) merged.set(c.name, (merged.get(c.name) ?? 0) + c.games)
  return [...merged].map(([name, games]) => ({ name, games })).sort((a, b) => b.games - a.games)
}

/** Role picker buttons: the streak role, and one per tilt role (`…:tilt:<role id>`). */
const STREAK_BUTTON = 'tracklatro:role:streak'
const TILT_BUTTON = 'tracklatro:role:tilt'
/** Discord allows 5 rows of 5 buttons per message. */
const MAX_TILT_ROLES = 24
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
      .setName('activity')
      .setDescription('Ranked activity: matches started per hour/day/week/month and when the queue is busiest')
      .addChannelOption(channelOption('Channel for the widget'))
  )
  .addSubcommand((s) =>
    s
      .setName('meta')
      .setDescription('Most picked decks and stakes this ranked season (charts)')
      .addChannelOption(channelOption('Channel for the widget'))
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
            { name: 'Tilt-queue pings', value: 'tilt' },
            { name: 'Activity widget', value: 'activity' },
            { name: 'Meta widget', value: 'meta' }
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
  .addSubcommandGroup((g) =>
    g
      .setName('tilt-roles')
      .setDescription('Tilt alert roles, each optionally for an MMR range')
      .addSubcommand((s) =>
        s
          .setName('add')
          .setDescription('Add (or change) a tilt alert role; leave out min/max for an open-ended range')
          .addRoleOption((o) => o.setName('role').setDescription('Role to ping').setRequired(true))
          .addIntegerOption((o) => o.setName('min_mmr').setDescription('Only players at or above this MMR').setMinValue(0))
          .addIntegerOption((o) => o.setName('max_mmr').setDescription('Only players at or below this MMR').setMinValue(0))
      )
      .addSubcommand((s) =>
        s
          .setName('remove')
          .setDescription('Remove a tilt alert role')
          .addRoleOption((o) => o.setName('role').setDescription('Role to remove').setRequired(true))
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
  readonly #api: Api
  readonly #results: ResultSource
  #statsTimers: NodeJS.Timeout[] = []
  /** The site's popularity stats are failing: don't ask again before this. */
  #siteMetaRetryAt = 0

  constructor(opts: {
    client: Client
    config: Config
    store: Store
    tracker: Tracker
    predictor: Predictor
    api: Api
    results: ResultSource
    label: (id: string) => string
    named: (ids: Iterable<string>) => Promise<void>
  }) {
    this.#client = opts.client
    this.#config = opts.config
    this.#api = opts.api
    this.#results = opts.results
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
    void this.#refreshActivity()
    void this.#refreshMeta()
    for (const t of this.#statsTimers) clearInterval(t)
    this.#statsTimers = [
      setInterval(() => void this.#refreshActivity(), ACTIVITY_REFRESH_MS),
      setInterval(() => void this.#refreshMeta(), META_REFRESH_MS),
    ]
  }

  stop() {
    if (this.#flushTimer) clearTimeout(this.#flushTimer)
    for (const t of this.#statsTimers) clearInterval(t)
  }

  // ------------------------------------------------------- activity and meta

  /** Ranked activity: matches started (counted live), tracked matches, and when the queue is busiest. */
  async #refreshActivity() {
    if (!this.#store.getSetting(S.activityChannel)) return
    try {
      const now = Date.now()
      const tz = this.#config.statsTimeZone
      const a = activitySummary(this.#store.activitySince(now - 31 * 24 * 3_600_000), now, tz, hourOfDay)
      const tracked = this.#store.trackedMatchCount()
      const n = (v: number | null) => (v === null ? '—' : `**${v.toLocaleString('en-US')}**`)
      const day = (ms: number) => `<t:${Math.floor(ms / 1000)}:D>`
      const lines = [
        '**Ranked matches started**',
        `Last hour: ${n(a.lastHour)} · Last 24h: ${n(a.lastDay)} · Last 7 days: ${n(a.lastWeek)} · Last 30 days: ${n(a.lastMonth)}`,
        `**Matches tracked with results:** ${tracked.matches.toLocaleString('en-US')}${tracked.since ? ` since ${day(tracked.since)}` : ''}`,
        a.since
          ? `-# Counted live by tracklatro since ${day(a.since)}, only while it runs, so longer windows fill in over time.`
          : '-# Counting starts as soon as the bot is connected to the site.',
      ]
      const embed = new EmbedBuilder().setTitle('📈 Ranked activity').setDescription(lines.join('\n')).setColor(C_BLURPLE).setTimestamp()
      const files: AttachmentBuilder[] = []
      if (a.perHourOfDay.some((v) => v !== null)) {
        const png = renderPng(busiestHoursSvg(a.perHourOfDay, hourOfDay(now, tz), tz, Math.max(1, a.days)))
        files.push(new AttachmentBuilder(png, { name: 'busiest-hours.png' }))
        embed.setImage('attachment://busiest-hours.png')
      }
      await this.#upsert(S.activityChannel, S.activityMessage, { embeds: [embed], files })
    } catch (err) {
      warn('activity widget', err)
    }
  }

  /**
   * Deck and stake pick rates this ranked season, as charts. From the site's
   * popularity stats when they work; otherwise from the ranked matches the bot
   * knows of itself (and the site isn't asked again for a while).
   */
  async #refreshMeta() {
    if (!this.#store.getSetting(S.metaChannel)) return
    try {
      const season = (await this.#results.seasons()).active
      let source = 'balatromp.com'
      const picks: Record<'deck' | 'stake', Popularity[]> = { deck: [], stake: [] }
      let fromSite = false
      if (Date.now() >= this.#siteMetaRetryAt) {
        try {
          picks.deck = await this.#api.fetchPopularity('deck', season, this.#config.queueId)
          picks.stake = await this.#api.fetchPopularity('stake', season, this.#config.queueId)
          fromSite = picks.deck.length > 0
        } catch (err) {
          warn('site popularity stats (using own data)', err)
          this.#siteMetaRetryAt = Date.now() + SITE_META_RETRY_MS
        }
      }
      if (!fromSite) {
        for (const kind of ['deck', 'stake'] as const) {
          picks[kind] = popularityFromCounts(
            mergeCounts(this.#store.pickCounts(kind, season).map((c) => ({ name: pickName(c.name), games: c.games })))
          )
        }
        const matches = picks.deck.reduce((sum, p) => sum + p.games, 0)
        source = `${matches.toLocaleString('en-US')} ranked matches tracklatro knows of (the site's stats are unavailable)`
      }
      if (!picks.deck.length && !picks.stake.length) return
      const embeds: EmbedBuilder[] = []
      const files: AttachmentBuilder[] = []
      for (const kind of ['deck', 'stake'] as const) {
        if (!picks[kind].length) continue
        const name = `${kind}-picks.png`
        files.push(new AttachmentBuilder(renderPng(popularitySvg(kind, picks[kind], season)), { name }))
        embeds.push(new EmbedBuilder().setImage(`attachment://${name}`).setColor(kind === 'deck' ? 0xf5a623 : 0x4aa8ff))
      }
      embeds[0]!.setTitle('🃏 Ranked meta').setDescription(`What's picked this season · ${source}`)
      embeds.at(-1)!.setTimestamp()
      await this.#upsert(S.metaChannel, S.metaMessage, { embeds, files })
    } catch (err) {
      warn('meta widget', err)
    }
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
  async #upsert(
    channelSetting: string,
    messageSetting: string,
    payload: { embeds: EmbedBuilder[]; components?: ActionRowBuilder<ButtonBuilder>[]; files?: AttachmentBuilder[] }
  ) {
    const channel = await this.#channel(this.#store.getSetting(channelSetting))
    if (!channel) return
    const messageId = this.#store.getSetting(messageSetting)
    if (messageId) {
      try {
        // With new images, drop the old ones (edits keep attachments unless told otherwise).
        const attachments = payload.files ? { attachments: [] } : {}
        await channel.messages.edit(messageId, { ...payload, ...attachments, allowedMentions: { parse: [] } })
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

  /**
   * Pings about a player, once per `dedupe` value (a streak, a loss). Tilt
   * alerts go out as one message mentioning every tilt role whose MMR range
   * holds the player (none: no message).
   */
  async #ping(kind: 'streak' | 'tilt', playerId: string, dedupe: number, count: number) {
    const channel = await this.#channel(this.#store.getSetting(kind === 'streak' ? S.streakChannel : S.tiltChannel))
    const key = `${kind}:${playerId}`
    if (!channel || this.#pinged.get(key) === dedupe) return
    const streakRole = this.#store.getSetting(S.streakRole)
    const roleIds =
      kind === 'streak'
        ? streakRole
          ? [streakRole]
          : []
        : tiltRolesFor(this.#tiltRoles(), this.#tracker.players.get(playerId)?.mmr)
    if (!roleIds.length) return
    this.#pinged.set(key, dedupe)
    await this.#named([playerId])
    const label = this.#label(playerId)
    const content = kind === 'streak' ? streakAlert(label, count, roleIds[0]!) : tiltAlert(label, count, roleIds)
    await channel.send({ content, allowedMentions: { roles: roleIds } }).catch((err) => warn(`${kind} ping`, err))
  }

  /** Tilt alert roles; a role set up before ranges existed becomes an all-MMR one. */
  #tiltRoles(): TiltRole[] {
    let roles: TiltRole[] = []
    try {
      roles = JSON.parse(this.#store.getSetting(S.tiltRoles) ?? '[]') as TiltRole[]
    } catch {
      warn('tilt roles', 'unreadable setting, starting empty')
    }
    const legacy = this.#store.getSetting(S.tiltRole)
    if (legacy) {
      if (!roles.some((r) => r.roleId === legacy)) roles.unshift({ roleId: legacy })
      this.#saveTiltRoles(roles)
      this.#store.deleteSetting(S.tiltRole)
    }
    return roles
  }

  #saveTiltRoles(roles: TiltRole[]) {
    this.#store.setSetting(S.tiltRoles, JSON.stringify(roles))
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
      buttons.push(roleButton(STREAK_BUTTON, 'Win-streak alerts', '🔥'))
    }
    const tiltRoles = this.#tiltRoles()
    if (tiltRoles.length) {
      const ranged = tiltRoles.some((r) => r.min !== undefined || r.max !== undefined)
      alerts.tilt = { channelId: this.#store.getSetting(S.tiltChannel), minLosses: this.#tiltMin(), ranged }
      for (const r of tiltRoles) {
        buttons.push(roleButton(`${TILT_BUTTON}:${r.roleId}`, ranged ? `Tilt: ${rangeLabel(r)}` : 'Tilt-queue alerts', '😤'))
      }
    }
    const content = rolesWidget(alerts)
    const embed = new EmbedBuilder()
      .setTitle(content.title)
      .setDescription(content.description)
      .setFooter({ text: content.footer })
      .setColor(0xe67e22)
    const components: ActionRowBuilder<ButtonBuilder>[] = []
    for (let i = 0; i < buttons.length; i += 5) {
      components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(i, i + 5)))
    }
    await this.#upsert(S.rolesChannel, S.rolesMessage, { embeds: [embed], components })
  }

  /** Returns true if this was one of our buttons. */
  async handleButton(i: ButtonInteraction): Promise<boolean> {
    let roleId: string | undefined
    if (i.customId === STREAK_BUTTON) {
      roleId = this.#store.getSetting(S.streakRole)
    } else if (i.customId.startsWith(TILT_BUTTON)) {
      // `…:tilt:<role id>`; a bare `…:tilt` is a button from before ranges (the all-MMR role).
      const id = i.customId.slice(TILT_BUTTON.length + 1)
      const roles = this.#tiltRoles()
      roleId = id ? roles.find((r) => r.roleId === id)?.roleId : roles.find((r) => r.min === undefined && r.max === undefined)?.roleId
    } else {
      return false
    }
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

    if (i.options.getSubcommandGroup(false) === 'tilt-roles') {
      const role = i.options.getRole('role', true)
      const roles = this.#tiltRoles().filter((r) => r.roleId !== role.id)
      if (sub === 'remove') {
        this.#saveTiltRoles(roles)
        await this.#refreshRolesWidget()
        return reply(`${role} no longer gets tilt alerts.`)
      }
      const min = i.options.getInteger('min_mmr') ?? undefined
      const max = i.options.getInteger('max_mmr') ?? undefined
      if (min !== undefined && max !== undefined && min > max) return reply('`min_mmr` must be at most `max_mmr`.')
      if (roles.length >= MAX_TILT_ROLES) return reply(`That's the maximum of ${MAX_TILT_ROLES} tilt roles (one button each).`)
      const problem = roleProblem(role, i.guild.members.me!)
      if (problem) return reply(problem)
      roles.push({ roleId: role.id, min, max })
      roles.sort((a, b) => (a.min ?? -1) - (b.min ?? -1) || (a.max ?? Infinity) - (b.max ?? Infinity))
      this.#saveTiltRoles(roles)
      await this.#refreshRolesWidget()
      return reply(
        `${role} gets tilt alerts for **${rangeLabel({ min, max })}**.` +
          (this.#store.getSetting(S.tiltChannel) ? '' : '\nSet the channel with `/setup tilt`.') +
          (this.#store.getSetting(S.rolesChannel) ? '' : '\nPost a role picker with `/setup roles` so people can pick it.') +
          (role.mentionable ? '' : "\n⚠️ That role isn't mentionable: turn on **Allow anyone to @mention this role**, or the pings won't notify anyone.")
      )
    }

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
      const tiltRoles = this.#tiltRoles().map((r) => `  · <@&${r.roleId}>: ${rangeLabel(r)}`)
      return reply(
        [
          `**Ongoing matches widget:** ${ch(S.matchesChannel)}`,
          `**Queue widget:** ${ch(S.queueChannel)}`,
          `**Results:** ${ch(S.resultsChannel)}`,
          `**Role picker:** ${ch(S.rolesChannel)}`,
          `**Win-streak pings:** ${ch(S.streakChannel)} · ${role(S.streakRole)} · ${this.#streakMin()}+ wins`,
          `**Tilt-queue pings:** ${ch(S.tiltChannel)} · ${this.#tiltMin()}+ losses, requeued within ${this.#tiltWindowMs() / 60_000} min`,
          ...(tiltRoles.length ? tiltRoles : ['  · no tilt roles (`/setup tilt-roles add`)']),
          `**Activity widget:** ${ch(S.activityChannel)}`,
          `**Meta widget:** ${ch(S.metaChannel)}`,
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
      } else if (feature === 'activity' || feature === 'meta') {
        const [channelSetting, messageSetting] =
          feature === 'activity' ? [S.activityChannel, S.activityMessage] : [S.metaChannel, S.metaMessage]
        await this.#deleteMessage(channelSetting, messageSetting)
        this.#store.deleteSetting(channelSetting)
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

    if (sub === 'activity' || sub === 'meta') {
      const [channelSetting, messageSetting] = sub === 'activity' ? [S.activityChannel, S.activityMessage] : [S.metaChannel, S.metaMessage]
      if (!channel.permissionsFor(i.guild.members.me!)?.has(PermissionFlagsBits.AttachFiles)) {
        return reply(`I also need **Attach Files** in ${channel} for the charts.`)
      }
      await this.#deleteMessage(channelSetting, messageSetting)
      this.#store.setSetting(channelSetting, channel.id)
      await reply(`The ${sub} widget will appear in ${channel} shortly.`)
      void (sub === 'activity' ? this.#refreshActivity() : this.#refreshMeta())
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
      if (!streakRole && !tiltRole && !this.#store.getSetting(S.streakRole) && !this.#tiltRoles().length) {
        return reply('Give at least one role: `streak_role` and/or `tilt_role` (or add ranged ones with `/setup tilt-roles add`).')
      }
      for (const role of [streakRole, tiltRole]) {
        const problem = role && roleProblem(role, i.guild.members.me!)
        if (problem) return reply(problem)
      }
      await this.#deleteMessage(S.rolesChannel, S.rolesMessage)
      this.#store.setSetting(S.rolesChannel, channel.id)
      if (streakRole) this.#store.setSetting(S.streakRole, streakRole.id)
      // A tilt role given here is for all MMR; keep its range if it already has one.
      const tiltRoles = this.#tiltRoles()
      if (tiltRole && !tiltRoles.some((r) => r.roleId === tiltRole.id)) {
        this.#saveTiltRoles([{ roleId: tiltRole.id }, ...tiltRoles].slice(0, MAX_TILT_ROLES))
      }
      await this.#postRolesWidget()
      return reply(`Role picker posted in ${channel}.`)
    }

    if (sub === 'streak' || sub === 'tilt') {
      const roles = sub === 'streak' ? [this.#store.getSetting(S.streakRole)].filter((r) => r !== undefined) : this.#tiltRoles().map((r) => r.roleId)
      if (!roles.length) {
        return reply(sub === 'streak' ? 'Set up the role first: `/setup roles streak_role:…`.' : 'Add a tilt role first: `/setup tilt-roles add`.')
      }
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
      const notMentionable = roles.filter((r) => !i.guild.roles.cache.get(r)?.mentionable)
      return reply(
        `${roles.map((r) => `<@&${r}>`).join(' ')} will be pinged in ${channel} when ${what}` +
          (sub === 'tilt' ? ' (each role only for its MMR range, in one message).' : '.') +
          (notMentionable.length
            ? `\n⚠️ Not mentionable: ${notMentionable.map((r) => `<@&${r}>`).join(' ')}. Turn on **Allow anyone to @mention this role** (or give me **Mention Everyone**), or the pings won't notify anyone.`
            : '')
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
