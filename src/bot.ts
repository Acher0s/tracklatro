import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ApplicationIntegrationType,
  AttachmentBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  Client,
  DiscordAPIError,
  Events,
  EmbedBuilder,
  escapeMarkdown,
  GatewayIntentBits,
  InteractionContextType,
  type Message,
  MessageFlags,
  SlashCommandBuilder,
  type SlashCommandStringOption,
  type StringSelectMenuInteraction,
  StringSelectMenuBuilder,
} from 'discord.js'
import { fileURLToPath } from 'node:url'
import type { Api } from './api.ts'
import type { Config } from './config.ts'
import { describeMask, NOTIFY_ALL, Notify, type NotifyKind, type Store } from './db.ts'
import { formatDuration } from './matchmaking.ts'
import type { Directory } from './directory.ts'
import { Emojis } from './emoji.ts'
import { QUEUE_STAGE_EMOJI, QueuePosts } from './queue-posts.ts'
import type { ResultSource } from './results.ts'
import { SETUP_COMMAND, ServerFeatures } from './server.ts'
import { mmrByHourSvg, renderPng } from './charts.ts'
import { hourOfDay, type Rival, rivalsText, type StatsService, statsText } from './stats.ts'
import { isValidTimeZone, localTime, quickPickZones, suggestTimeZones } from './timezones.ts'
import type { Forecast, Predictor, ViewerForecast } from './predict.ts'
import type { MatchOutcome, Player, TrackedMatch, Tracker } from './tracker.ts'

const ts = (ms: number, style: 'R' | 't' | 'f' = 'R') => `<t:${Math.floor(ms / 1000)}:${style}>`

/**
 * Permissions the bot needs when added to a server: View Channels, Send
 * Messages, Embed Links, Attach Files (charts), Use External Emojis (its own
 * deck/stake emojis can count as external in a server, and would otherwise
 * show as plain :names:), Manage Roles (role picker).
 */
export const SERVER_PERMISSIONS = '268749824'

/** OAuth links for /install: to the user's own account (commands anywhere) or to a server. */
export function installLinks(applicationId: string): { user: string; server: string } {
  const base = `https://discord.com/oauth2/authorize?client_id=${applicationId}`
  return {
    user: `${base}&integration_type=1&scope=applications.commands`,
    server: `${base}&integration_type=0&scope=bot+applications.commands&permissions=${SERVER_PERMISSIONS}`,
  }
}

/** How long autocomplete waits for the site's player search. */
const AUTOCOMPLETE_SEARCH_MS = 1_500

/** Custom id of the "what time is it for you?" picker under /stats (`…:<player id>`). */
const TZ_PICKER = 'tracklatro:tz'

const NOTIFY_CHOICES = [
  { name: 'Everything (queue, match found, result)', value: 'all' },
  { name: 'Joins or leaves the queue', value: 'queue' },
  { name: 'Match found (who they play)', value: 'match' },
  { name: 'Game result', value: 'result' },
] as const

function maskFromChoice(choice: string | null): number {
  if (!choice || choice === 'all') return NOTIFY_ALL
  return Notify[choice as NotifyKind] ?? NOTIFY_ALL
}

const playerOption = (description: string) => (o: SlashCommandStringOption) =>
  o.setName('player').setDescription(description).setRequired(true).setAutocomplete(true)

const notifyOption = (description: string) => (o: SlashCommandStringOption) =>
  o
    .setName('notify')
    .setDescription(description)
    .addChoices(...NOTIFY_CHOICES)

function command(name: string, description: string) {
  // Usable in servers and, when user-installed, in DMs with the bot.
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
    .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel)
}

const COMMANDS = [
  command('subscribe', 'Get a DM when a player queues or leaves, finds a match, or finishes a game')
    .addStringOption(playerOption('Player to follow'))
    .addStringOption(notifyOption('What to be notified about (default: everything)')),
  command('unsubscribe', 'Stop (some) notifications for a player')
    .addStringOption(playerOption('Player to stop following'))
    .addStringOption(notifyOption('Which notifications to stop (default: all)')),
  command('subscriptions', 'List the players you follow'),
  command('status', "Show a player's current queue state").addStringOption(playerOption('Player to look up')),
  command('live', 'Who is queuing and who is playing whom right now'),
  command('recent', 'Recently tracked matches').addStringOption((o) =>
    o.setName('player').setDescription('Only matches of this player').setAutocomplete(true)
  ),
  command('matchup', 'How long until you could queue into a player, and who they would likely get').addStringOption(
    playerOption('Player you want to play')
  ),
  command('timezone', 'Set your time zone (used for the time of day in /stats)').addStringOption((o) =>
    o.setName('zone').setDescription('Your time zone: pick the one showing your current time').setAutocomplete(true)
  ),
  command('stats', "A player's ranked stats over all seasons")
    .addStringOption(playerOption('Player to look up'))
    .addBooleanOption((o) => o.setName('public').setDescription('Post it for everyone in the channel (default: only you)')),
  command('rivals', "A player's nemeses, favourite victims and most played opponents (ranked, all seasons)")
    .addStringOption(playerOption('Player to look up'))
    .addBooleanOption((o) => o.setName('public').setDescription('Post it for everyone in the channel (default: only you)')),
  command('install', 'Add tracklatro to your account (use it anywhere) or to a server'),
  command('about', 'How tracklatro works and what it is tracking'),
  SETUP_COMMAND,
]

export class Bot {
  readonly client = new Client({ intents: [GatewayIntentBits.Guilds] })
  readonly #cfg: Config
  readonly #store: Store
  readonly #tracker: Tracker
  readonly #api: Api
  readonly #predictor: Predictor
  readonly #directory: Directory
  readonly #stats: StatsService
  readonly #emojis = new Emojis()
  /** 🟢/🟡/⚪ color of "queued" posts, following each player's queue session. */
  readonly #queuePosts: QueuePosts
  /** /setup: widgets, results channel, role picker, win-streak pings. */
  readonly #server: ServerFeatures
  readonly #startedAt = Date.now()

  constructor(opts: {
    config: Config
    store: Store
    tracker: Tracker
    api: Api
    predictor: Predictor
    directory: Directory
    stats: StatsService
    results: ResultSource
  }) {
    this.#cfg = opts.config
    this.#store = opts.store
    this.#tracker = opts.tracker
    this.#api = opts.api
    this.#predictor = opts.predictor
    this.#directory = opts.directory
    this.#stats = opts.stats
    this.#queuePosts = new QueuePosts(this.#store, (channelId, messageId, content) =>
      this.#editMessage(channelId, messageId, content)
    )
    this.#server = new ServerFeatures({
      client: this.client,
      config: this.#cfg,
      api: opts.api,
      results: opts.results,
      store: this.#store,
      tracker: this.#tracker,
      predictor: this.#predictor,
      label: (id) => this.#label(id),
      named: (ids) => this.#named(ids),
    })
    // Players who aren't ranked this season still have a Discord name.
    this.#directory.discordName = async (id) => {
      const user = await this.client.users.fetch(id)
      return user.globalName ?? user.username
    }

    this.client.once(Events.ClientReady, async (c) => {
      console.log(`[bot] logged in as ${c.user.tag}`)
      const body = COMMANDS.map((cmd) => cmd.toJSON())
      // Only one set may exist, or Discord shows stale or duplicate commands:
      // server-only commands never appear in DMs, and an old global set
      // lingers there after switching to server-only registration.
      if (this.#cfg.guildId) {
        await c.application.commands.set(body, this.#cfg.guildId)
        await c.application.commands.set([])
        console.log(`[bot] registered ${body.length} commands in guild ${this.#cfg.guildId} only (not in DMs; unset DISCORD_GUILD_ID for that)`)
      } else {
        await c.application.commands.set(body)
        await Promise.all(c.guilds.cache.map((g) => g.commands.set([]).catch(() => {})))
        console.log(`[bot] registered ${body.length} commands globally (servers and DMs)`)
      }
      await this.#emojis
        .sync(c.application.emojis, fileURLToPath(new URL('../assets/emoji', import.meta.url)))
        .catch((err) => console.warn('[emoji] sync failed, using plain icons:', err))
      await this.#server.onReady()
    })
    this.client.on(Events.InteractionCreate, async (i) => {
      try {
        if (i.isAutocomplete()) await this.#autocomplete(i)
        else if (i.isButton()) await this.#server.handleButton(i)
        else if (i.isStringSelectMenu() && i.customId.startsWith(TZ_PICKER)) await this.#onTimeZonePick(i)
        else if (i.isChatInputCommand() && i.commandName === 'setup') await this.#server.handleSetup(i)
        else if (i.isChatInputCommand()) await this.#command(i)
      } catch (err) {
        console.error('[bot] interaction failed:', err)
        if (i.isRepliable() && !i.replied) {
          await i.reply({ content: 'Something went wrong.', flags: MessageFlags.Ephemeral }).catch(() => {})
        }
      }
    })

    this.#tracker.on('queue_join', (e) => void this.#onQueueJoin(e.playerId, e.since))
    this.#tracker.on('queue_leave', (e) => void this.#onQueueLeave(e.playerId, e.since))
    this.#tracker.on('match_start', (m) => void this.#onMatchStart(m))
    this.#tracker.on('match_result', (m, r) => void this.#onMatchResult(m, r))
    this.#tracker.once('round', () => void this.#queuePosts.reconcile((id) => this.#player(id)?.snapshot?.kind))
  }

  async start() {
    await this.client.login(this.#cfg.discordToken)
  }

  // ------------------------------------------------------------------ naming

  #player(id: string): Player | undefined {
    return this.#tracker.players.get(id)
  }

  #name(id: string): string {
    return (
      this.#player(id)?.name ??
      this.#directory.get(id)?.name ??
      this.client.users.cache.get(id)?.displayName ??
      // Never a <@mention>: those don't render inside links (or for users the viewer can't see).
      'unknown player'
    )
  }

  /** "**bacon** (#1 · 1624)" linked to their profile on the site. */
  #label(id: string): string {
    const p = this.#player(id)
    const info = this.#directory.get(id)
    const rank = p?.rank ?? p?.globalRank ?? info?.rank ?? undefined
    const mmr = p?.mmr ?? info?.mmr ?? undefined
    const meta =
      rank !== undefined && mmr !== undefined
        ? `#${rank} · ${Math.round(mmr)}`
        : mmr !== undefined
          ? `${Math.round(mmr)}`
          : undefined
    return playerLabel(this.#name(id), `${this.#cfg.siteUrl}/players/${id}`, meta)
  }

  /**
   * Resolves names for players about to be shown. Bounded so a slow site never
   * makes an interaction miss Discord's 3 s deadline; worst case a name shows
   * as "unknown player" once and is filled in for next time.
   */
  async #named(ids: Iterable<string>, timeoutMs = 2_000): Promise<void> {
    await Promise.race([
      this.#directory.ensure([...ids]).catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ])
  }

  /** Top players get announced in the feed channel; the rest is DM-only. */
  #featured(ids: readonly string[]): boolean {
    const top = this.#cfg.topN === 0 ? 100 : this.#cfg.topN
    return ids.some((id) => (this.#player(id)?.rank ?? Infinity) <= top)
  }

  // ----------------------------------------------------------- notifications

  async #dm(userId: string, content: string): Promise<Message | undefined> {
    try {
      return await this.client.users.send(userId, { content, allowedMentions: { parse: [] } })
    } catch (err) {
      const reason = err instanceof DiscordAPIError && err.code === 50007 ? 'DMs closed' : String(err)
      console.warn(`[bot] could not DM ${userId}: ${reason}`)
      return undefined
    }
  }

  async #editMessage(channelId: string, messageId: string, content: string) {
    try {
      const channel = await this.client.channels.fetch(channelId)
      if (channel?.isTextBased()) await channel.messages.edit(messageId, { content, allowedMentions: { parse: [] } })
    } catch (err) {
      // Deleted by someone, or DMs closed since: nothing to recolor.
      console.warn(`[bot] couldn't edit message ${messageId}:`, err instanceof Error ? err.message : err)
    }
  }

  async #feed(content: string): Promise<Message | undefined> {
    if (!this.#cfg.feedChannelId) return undefined
    try {
      const channel = await this.client.channels.fetch(this.#cfg.feedChannelId)
      if (channel?.isSendable()) return await channel.send({ content, allowedMentions: { parse: [] } })
    } catch (err) {
      console.warn('[bot] feed post failed:', err)
    }
    return undefined
  }

  /** Removes a finished match's "started" post(s) from the feed. */
  async #removeFeedStart(m: TrackedMatch) {
    const ids = this.#store.takeFeedMessages(m.players[0], m.players[1], m.startTime)
    if (!ids.length || !this.#cfg.feedChannelId) return
    try {
      const channel = await this.client.channels.fetch(this.#cfg.feedChannelId)
      if (!channel?.isTextBased() || channel.isDMBased()) return
      // Deleting our own messages needs no extra permission; one already gone is fine.
      await Promise.all(ids.map((id) => channel.messages.delete(id).catch(() => {})))
    } catch (err) {
      console.warn('[bot] removing feed post failed:', err)
    }
  }

  /** Everyone subscribed to any of `targets` whose mask passes `wants`, once per user. */
  #recipients(targets: readonly string[], wants: (mask: number, target: string) => boolean): Set<string> {
    const recipients = new Set<string>()
    for (const target of targets) {
      for (const [userId, mask] of this.#store.subscribersOf(target)) {
        if (wants(mask, target)) recipients.add(userId)
      }
    }
    return recipients
  }

  async #notify(targets: readonly string[], wants: (mask: number, target: string) => boolean, content: string) {
    await Promise.all([...this.#recipients(targets, wants)].map((u) => this.#dm(u, content)))
  }

  async #onQueueLeave(playerId: string, since: number) {
    void this.#queuePosts.left(playerId)
    const queuedMs = Date.now() - since
    // A queue state that went stale was expired by us, not left by the player.
    if (queuedMs >= this.#cfg.staleQueueMs) return
    await this.#named([playerId], 5_000)
    const msg = `🔴 ${this.#label(playerId)} left the queue after ${formatDuration(queuedMs)}.`
    await Promise.all([
      this.#notify([playerId], (mask) => (mask & Notify.queue) !== 0, msg),
      this.#featured([playerId]) ? this.#feed(msg) : undefined,
    ])
  }

  async #onQueueJoin(playerId: string, since: number) {
    void this.#queuePosts.joined(playerId)
    void this.#server.onQueueJoin(playerId, since)
    await this.#named([playerId], 5_000)
    const msg = `${QUEUE_STAGE_EMOJI.queuing} ${this.#label(playerId)} queued ${ts(since)}.`
    const recipients = this.#recipients([playerId], (mask) => (mask & Notify.queue) !== 0)
    // Forecasts only cost requests when someone will actually read them.
    const forecast = recipients.size
      ? await this.#predictor.forecast(playerId, [...recipients]).catch((err) => {
          console.warn('[bot] forecast failed:', err)
          return null
        })
      : null
    const sent = await Promise.all([
      ...[...recipients].map((userId) =>
        this.#dm(userId, forecast ? [msg, ...this.#forecastLines(forecast.base, forecast.viewers.get(userId))].join('\n') : msg)
      ),
      this.#featured([playerId]) ? this.#feed(msg) : undefined,
    ])
    await this.#queuePosts.posted(
      playerId,
      sent.filter((m): m is Message => m !== undefined)
    )
  }

  // ---------------------------------------------------------------- forecasts

  #forecastLines(f: Forecast, you?: ViewerForecast): string[] {
    const now = Date.now()
    const inMs = (at: number) => `~${formatDuration(at - now)}`
    const queue = `${f.visibleOthers} other${f.visibleOthers === 1 ? '' : 's'} visible in queue${f.unseen ? ` (+${f.unseen} I can't see)` : ''}`
    const lines = [f.likely ? `🔮 Likely vs ${this.#label(f.likely.opponent)} in ${inMs(f.likely.at)} · ${queue}.` : `🔮 ${queue}.`]

    if (you?.kind === 'estimate') {
      const how = you.instaqueue ? 'instaqueue' : `gap ${Math.round(you.gap)}`
      const o = you.outcome
      if (o?.isYou) {
        lines.push(`🎯 If you queued now, you'd match against them in ${inMs(o.at)} (${how}).`)
      } else if (o) {
        lines.push(
          `🎯 If you queued now, you'd be in range in ${inMs(you.pairableAt)} (${how}), ` +
            `but they'd likely be paired with ${this.#label(o.opponent)} first (${inMs(o.at)}).`
        )
      } else {
        lines.push(`🎯 If you queued now, you'd be in range in ${inMs(you.pairableAt)} (${how}).`)
      }
    } else if (you?.kind === 'unranked') {
      lines.push("🎯 You're not on the ranked leaderboard, so no estimate.")
    } else if (you?.kind === 'busy') {
      lines.push(you.status === 'in_game' ? "🎯 You're in a game." : "🎯 You're already queuing (counted above).")
    }

    lines.push('-# Speculative: assumes nobody joins or leaves the queue.')
    return lines
  }

  async #onMatchStart(m: TrackedMatch) {
    for (const p of m.players) void this.#queuePosts.matched(p)
    const [a, b] = m.players
    this.#store.logMatchStart(a, b, m.startTime)
    await this.#named(m.players, 5_000)
    const msg = `⚔️ ${this.#label(a)} vs ${this.#label(b)} · started ${ts(m.startTime)}${m.late ? ' (seen late)' : ''}.`
    const [, posted] = await Promise.all([
      this.#notify(
        m.players,
        // Queue-only subscribers still hear about it if the queue phase was
        // too short for us to see: from their point of view, they queued.
        (mask, target) => (mask & Notify.match) !== 0 || ((mask & Notify.queue) !== 0 && m.unseenQueue.has(target)),
        msg
      ),
      this.#featured(m.players) && !m.late ? this.#feed(msg) : undefined,
    ])
    if (posted) {
      this.#store.addFeedMessage(a, b, m.startTime, posted.id)
      // Over before the post went out (e.g. cancelled within seconds): remove it right away.
      if (m.resultReported) await this.#removeFeedStart(m)
    }
  }

  async #onMatchResult(m: TrackedMatch, outcome: MatchOutcome) {
    const [a, b] = m.players
    const ended = m.endedAt ?? Date.now()
    m.resultReported = true
    void this.#removeFeedStart(m)
    for (const p of m.players) void this.#queuePosts.matchOver(p)
    await this.#named(m.players, 5_000)
    let msg: string
    if (outcome.status !== 'found') {
      this.#store.logMatchResult(a, b, m.startTime, ended, null, null)
      // Never announced (first seen already running, e.g. at startup) and nothing to
      // report: usually a cancelled match the site never cleared. Stay quiet.
      if (m.late) return
      const why = outcome.status === 'not_found' ? 'no result (likely cancelled)' : 'result unavailable'
      msg = `⚪ ${this.#label(a)} vs ${this.#label(b)} ended · ${why}.`
    } else {
      const r = outcome.result
      // r is from a's perspective (the site only reports that player's MMR change).
      const [winner, loser] = r.won ? [a, b] : [b, a]
      this.#store.logMatchResult(a, b, m.startTime, ended, r.matchId, winner)
      const change = `${r.mmrChange >= 0 ? '+' : ''}${r.mmrChange.toFixed(1)} for ${escapeMarkdown(this.#name(r.playerId))}`
      const details = [
        r.deck && `${this.#emojis.get('deck', r.deck)} ${r.deck}`,
        r.stake && `${this.#emojis.get('stake', r.stake)} ${r.stake}`,
        change,
        // Start → when we saw it end (within a poll interval of the real end).
        `⏱️ ${formatDuration(ended - m.startTime)}`,
      ]
        .filter(Boolean)
        .join(' · ')
      // A timed-out match we'd reported as "no result" that did finish after all.
      msg = `🏆 ${this.#label(winner)} beat ${this.#label(loser)} · ${details}${m.lateResult ? ' · (finished after all)' : ''}`
    }
    const featured = this.#featured(m.players)
    await Promise.all([
      this.#notify(m.players, (mask) => (mask & Notify.result) !== 0, msg),
      featured ? this.#feed(msg) : undefined,
      // The results channel only gets matches that actually finished.
      featured && outcome.status === 'found' ? this.#server.postResult(msg) : undefined,
    ])
  }

  // ---------------------------------------------------------------- commands

  /** Accepts an autocompleted id, a raw id, a mention, or a (partial) name. */
  #resolvePlayer(input: string): string | null {
    const id = /^<@!?(\d{17,20})>$/.exec(input)?.[1] ?? (/^\d{17,20}$/.test(input) ? input : null)
    if (id) return id
    const q = input.trim().toLowerCase()
    const named = [...this.#tracker.players.values()].filter((p) => p.name)
    return (
      named.find((p) => p.name!.toLowerCase() === q)?.id ??
      named
        .filter((p) => p.name!.toLowerCase().startsWith(q))
        .sort((x, y) => (x.rank ?? Infinity) - (y.rank ?? Infinity))[0]?.id ??
      null
    )
  }

  async #autocomplete(i: AutocompleteInteraction) {
    if (i.commandName === 'timezone') return i.respond(suggestTimeZones(i.options.getFocused(), i.locale))
    const q = i.options.getFocused().toLowerCase()
    let ids: string[]
    if (i.commandName === 'unsubscribe') {
      ids = this.#store.subscriptionsOf(i.user.id).map((s) => s.target_id)
    } else {
      ids = [...this.#tracker.players.values()]
        .filter((p) => p.name)
        .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity))
        .map((p) => p.id)
    }
    const choices = ids
      .filter((id) => this.#name(id).toLowerCase().includes(q))
      .slice(0, 25)
      .map((id) => {
        const rank = this.#player(id)?.rank
        return { name: `${this.#name(id)}${rank !== undefined ? ` (#${rank})` : ''}`.slice(0, 100), value: id }
      })
    // Anyone else on the ranked leaderboard, via the site's search (bounded so
    // autocomplete answers within Discord's 3 s even if the site is slow).
    if (i.commandName !== 'unsubscribe' && q.trim().length >= 2 && choices.length < 25) {
      const hits = await Promise.race([
        this.#directory.search(q).catch(() => []),
        new Promise<[]>((resolve) => setTimeout(() => resolve([]), AUTOCOMPLETE_SEARCH_MS)),
      ])
      const seen = new Set(choices.map((c) => c.value))
      for (const hit of hits) {
        if (seen.has(hit.id) || choices.length >= 25) continue
        choices.push({ name: `${hit.name} (${Math.round(hit.mmr)} MMR)`.slice(0, 100), value: hit.id })
      }
    }
    await i.respond(choices)
  }

  async #command(i: ChatInputCommandInteraction) {
    const reply = (content: string) =>
      i.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } })
    /** Long lists: first chunk as the reply, the rest as (ephemeral) follow-ups. */
    const replyLines = async (lines: string[]) => {
      const [first = '…', ...rest] = chunkLines(lines)
      await reply(first)
      for (const content of rest) {
        await i.followUp({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } })
      }
    }

    switch (i.commandName) {
      case 'subscribe': {
        const id = this.#resolvePlayer(i.options.getString('player', true))
        if (!id) return reply('Unknown player. Pick a suggestion or paste a user ID.')
        if (id === i.user.id) return reply("That's you. 🙂")
        const existing = this.#store.subscriptionsOf(i.user.id)
        if (!existing.some((s) => s.target_id === id) && existing.length >= this.#cfg.maxSubscriptionsPerUser) {
          return reply(`You can follow up to ${this.#cfg.maxSubscriptionsPerUser} players. /unsubscribe someone first.`)
        }
        const mask = this.#store.subscribe(i.user.id, id, maskFromChoice(i.options.getString('notify')))
        this.#tracker.heat(id) // poll them right away so /status is fresh
        const outside = this.#player(id)?.rank === undefined
        await reply(
          `Following ${this.#label(id)} (${describeMask(mask)}).` +
            (outside ? '\n-# Outside the tracked range; tracked because you follow them.' : '')
        )
        // Make sure DMs actually reach them; include how this matchup looks.
        const forecast = await this.#predictor.forecast(id, [i.user.id]).catch(() => null)
        const lines = [`🔔 Following ${this.#label(id)} (${describeMask(mask)}).`]
        if (forecast) lines.push(...this.#forecastLines(forecast.base, forecast.viewers.get(i.user.id)))
        try {
          await i.user.send({ content: lines.join('\n'), allowedMentions: { parse: [] } })
        } catch {
          await i.followUp({
            content: "⚠️ I can't DM you. Allow DMs from server members (or add me as a user app) to get notifications.",
            flags: MessageFlags.Ephemeral,
          })
        }
        return
      }

      case 'unsubscribe': {
        const id = this.#resolvePlayer(i.options.getString('player', true))
        if (!id || !this.#store.subscribersOf(id).has(i.user.id)) return reply("You're not following that player.")
        const remaining = this.#store.unsubscribe(i.user.id, id, maskFromChoice(i.options.getString('notify')))
        return reply(
          remaining === 0
            ? `Unfollowed ${this.#label(id)}.`
            : `Still following ${this.#label(id)} (${describeMask(remaining)}).`
        )
      }

      case 'subscriptions': {
        const subs = this.#store.subscriptionsOf(i.user.id)
        if (subs.length === 0) return reply("You're not following anyone. Try /subscribe.")
        await this.#named(subs.flatMap((s) => [s.target_id, ...this.#opponentOf(s.target_id)]))
        return replyLines(
          subs.map((s) => `• ${this.#label(s.target_id)} — ${describeMask(s.mask)} · ${this.#stateLine(s.target_id)}`)
        )
      }

      case 'status': {
        const id = this.#resolvePlayer(i.options.getString('player', true))
        if (!id) return reply("I don't know that player.")
        const p = this.#player(id)
        const recent = this.#store.recentMatches(3, id)
        await this.#named([id, ...this.#opponentOf(id), ...recent.flatMap((r) => [r.player_a, r.player_b])])
        const lines = [`${this.#label(id)}: ${this.#stateLine(id)}`]
        if (p?.lastPolledAt) lines.push(`-# checked ${ts(p.lastPolledAt)} · ${this.#tracker.tier(p, Date.now())}`)
        if (recent.length) lines.push('', '**Recent**', ...recent.map((r) => this.#matchLine(r)))
        return reply(lines.join('\n'))
      }

      case 'live': {
        const now = Date.now()
        const queuing = [...this.#tracker.players.values()]
          .filter((p) => p.snapshot?.kind === 'queuing')
          .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity))
        const matches = [...this.#tracker.activeMatches].sort((a, b) => b.startTime - a.startTime)
        await this.#named([...queuing.map((p) => p.id), ...matches.flatMap((m) => m.players)])
        const lines = [
          `**Queuing (${queuing.length})**`,
          ...(queuing.length
            ? queuing.map((p) => `• ${this.#label(p.id)} · ${ts(p.snapshot?.kind === 'queuing' ? p.snapshot.since : now)}`)
            : ['-# nobody']),
          '',
          `**In game (${matches.length})**`,
          ...(matches.length
            ? matches.map((m) => `• ${this.#label(m.players[0])} vs ${this.#label(m.players[1])} · ${ts(m.startTime)}`)
            : ['-# nobody']),
        ]
        if (this.#tracker.paused) lines.push('', '-# ⏸️ Paused: nobody is subscribed.')
        return replyLines(lines)
      }

      case 'recent': {
        const raw = i.options.getString('player')
        const id = raw ? this.#resolvePlayer(raw) : undefined
        if (raw && !id) return reply('Unknown player.')
        const rows = this.#store.recentMatches(10, id ?? undefined)
        await this.#named(rows.flatMap((r) => [r.player_a, r.player_b]))
        return rows.length ? replyLines(rows.map((r) => this.#matchLine(r))) : reply('No tracked matches yet.')
      }

      case 'matchup': {
        const id = this.#resolvePlayer(i.options.getString('player', true))
        if (!id) return reply('Unknown player.')
        if (id === i.user.id) return reply("That's you. 🙂")
        await i.deferReply({ flags: MessageFlags.Ephemeral })
        const forecast = await this.#predictor.forecast(id, [i.user.id])
        if (!forecast) return i.editReply(`${this.#label(id)} isn't on the ranked leaderboard.`)
        const state = this.#player(id)?.snapshot
        const header =
          state?.kind === 'in_game'
            ? `${this.#label(id)} is in a game. Once they requeue:`
            : state?.kind === 'queuing'
              ? `${this.#label(id)} queued ${ts(state.since)}.`
              : `${this.#label(id)} isn't queuing. If they did:`
        return i.editReply({
          content: [header, ...this.#forecastLines(forecast.base, forecast.viewers.get(i.user.id))].join('\n'),
          allowedMentions: { parse: [] },
        })
      }

      case 'timezone': {
        const zone = i.options.getString('zone')?.trim()
        const current = this.#store.getUserSetting(i.user.id, 'timezone')
        if (!zone) {
          return reply(
            current
              ? `Your time zone is **${current}** (now ${localTime(current)}).`
              : `No time zone set, so /stats uses ${this.#cfg.statsTimeZone}. Pick yours with \`/timezone zone:\`.`
          )
        }
        if (!isValidTimeZone(zone)) return reply('Unknown time zone. Pick one of the suggestions (they show their current time).')
        this.#store.setUserSetting(i.user.id, 'timezone', zone)
        return reply(`Time zone set to **${zone}** (now ${localTime(zone)}). /stats will show times of day in it.`)
      }

      case 'stats':
      case 'rivals': {
        const id = this.#resolvePlayer(i.options.getString('player', true))
        if (!id) return reply('Unknown player. Pick a suggestion or paste a user ID.')
        const isPublic = i.options.getBoolean('public') ?? false
        await i.deferReply(isPublic ? {} : { flags: MessageFlags.Ephemeral })
        const note = await this.#syncHistory(i, id)
        if (i.commandName === 'stats') {
          return i.editReply({ content: '', ...(await this.#statsMessage(id, i.user.id, i.locale, note)) })
        }
        const rivals = this.#stats.rivals(id)
        const embed = new EmbedBuilder()
          .setTitle(`⚔️ ${this.#name(id)} · rivals`)
          .setURL(`${this.#cfg.siteUrl}/players/${id}`)
          .setDescription(`${rivalsText(rivals, (r) => this.#rivalLabel(r))}${note}`)
          .setFooter({ text: 'Ranked · all seasons · nemeses and victims need 3+ games against them' })
          .setColor(0xed4245)
        return i.editReply({ content: '', embeds: [embed], allowedMentions: { parse: [] } })
      }

      case 'install': {
        const id = this.client.application?.id ?? this.client.user?.id
        if (!id) return reply("Couldn't work out the install links right now; try again in a moment.")
        const links = installLinks(id)
        const embed = new EmbedBuilder()
          .setTitle('📥 Get tracklatro')
          .setDescription(
            [
              '**Add to my apps**: use the commands anywhere: in any server and in your DMs, even where the bot itself isn\'t a member. Notifications still arrive as DMs from the bot.',
              '',
              '**Add to a server**: for server admins. Adds the bot to a server, for the live feed, widgets, results channel and role pings (`/setup`).',
            ].join('\n')
          )
          .setColor(0x5865f2)
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Add to my apps').setEmoji('👤').setURL(links.user),
          new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Add to a server').setEmoji('🏠').setURL(links.server)
        )
        return i.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral })
      }

      case 'about': {
        const now = Date.now()
        const tiers = { hot: 0, warm: 0, cold: 0 }
        for (const p of this.#tracker.players.values()) tiers[this.#tracker.tier(p, now)]++
        const hours = Math.max((now - this.#startedAt) / 3_600_000, 1 / 60)
        const requests = this.#api.requestCount
        return reply(
          [
            '**tracklatro** · Balatro MP queue tracker (data from balatromp.com)',
            `Tracking **${this.#tracker.players.size}** players (${this.#cfg.topN === 0 ? 'whole leaderboard' : `top ${this.#cfg.topN}`} + followed), speed **${this.#cfg.speed}**:`,
            `• 🔥 ${tiers.hot} hot · every ${this.#cfg.hotIntervalMs / 1000}s`,
            `• 🌤️ ${tiers.warm} warm · every ${this.#cfg.warmIntervalMs / 1000}s`,
            `• 🧊 ${tiers.cold} cold · in spare slots`,
            `Requests: ${requests} (~${Math.round(requests / hours)}/h)`,
            this.#modelLine(),
            `-# Leaderboard ${this.#tracker.lastLeaderboardAt ? ts(this.#tracker.lastLeaderboardAt) : 'never'} · last poll ${this.#tracker.lastPollAt ? ts(this.#tracker.lastPollAt) : 'never'}`,
          ].join('\n')
        )
      }
    }
  }

  /**
   * Brings a player's stored ranked history up to date (the first time it
   * fetches everything and says so). Returns a note for the reply if the site
   * couldn't be reached.
   */
  async #syncHistory(i: ChatInputCommandInteraction, id: string): Promise<string> {
    await this.#named([id])
    const label = this.#label(id)
    const firstTime = this.#stats.needsBackfill(id)
    if (firstTime) {
      await i.editReply({
        content: `⏳ Fetching ${label}'s ranked history from all seasons. First time only, this can take a bit…`,
        allowedMentions: { parse: [] },
      })
    }
    let lastProgress = Date.now()
    try {
      await this.#stats.sync(id, (p) => {
        if (!firstTime || Date.now() - lastProgress < 2_500) return
        lastProgress = Date.now()
        void i
          .editReply({
            content: `⏳ Fetching ${label}'s ranked history… season ${p.seasonIndex}/${p.seasons}, page ${p.page}/${p.pages}`,
            allowedMentions: { parse: [] },
          })
          .catch(() => {})
      })
      return ''
    } catch (err) {
      console.warn('[stats] history sync failed:', err)
      return "\n-# ⚠️ Couldn't reach the site's match history just now; this may be incomplete."
    }
  }

  /** A rival linked to their profile: the bot's current name for them if it has one, else the name from their games. */
  #rivalLabel(r: Rival): string {
    if (this.#player(r.id)?.name || this.#directory.get(r.id)) return this.#label(r.id)
    return playerLabel(r.name ?? 'unknown player', `${this.#cfg.siteUrl}/players/${r.id}`)
  }

  /** Current season rank, total players and MMR, if the player is ranked this season. */
  #standing(id: string): { rank: number; total: number; mmr?: number } | undefined {
    const p = this.#player(id)
    const info = this.#directory.get(id)
    const rank = p?.rank ?? p?.globalRank ?? info?.rank ?? undefined
    const total = this.#tracker.leaderboardTotal
    if (rank === undefined || total === undefined) return undefined
    return { rank, total, mmr: p?.mmr ?? info?.mmr ?? undefined }
  }

  /**
   * The /stats embed (+ MMR-by-hour chart image) for a player, with times in
   * the viewer's time zone. Discord doesn't tell bots a user's time zone, so
   * viewers without one get a one-click "what time is it for you?" picker.
   */
  async #statsMessage(playerId: string, viewerId: string, locale: string, note = '') {
    const viewerRanked = (await this.#predictor.mmrs([viewerId])).get(viewerId) != null
    const ownZone = this.#store.getUserSetting(viewerId, 'timezone')
    const s = this.#stats.stats(playerId, viewerId, ownZone ?? this.#cfg.statsTimeZone)
    const text = statsText(s, {
      deckEmoji: (deck) => this.#emojis.get('deck', deck),
      stakeEmoji: (stake) => this.#emojis.get('stake', stake),
      viewerRanked,
      isSelf: playerId === viewerId,
      rivalLabel: (r) => this.#rivalLabel(r),
      standing: this.#standing(playerId),
    })
    if (!ownZone) note += `\n-# Times are in ${this.#cfg.statsTimeZone}. Pick your time below (or use /timezone) to see them in yours.`
    const embed = new EmbedBuilder()
      .setTitle(`📊 ${this.#name(playerId)} · ranked stats`)
      .setURL(`${this.#cfg.siteUrl}/players/${playerId}`)
      .setDescription(`${text.description}${note}`)
      .setFooter({ text: text.footer })
      .setColor(0x5865f2)
    const files: AttachmentBuilder[] = []
    if (s.byHour.games) {
      try {
        const png = renderPng(mmrByHourSvg(s.byHour, hourOfDay(Date.now(), s.timeZone), s.timeZone))
        files.push(new AttachmentBuilder(png, { name: 'mmr-by-hour.png' }))
        embed.setImage('attachment://mmr-by-hour.png')
      } catch (err) {
        console.warn('[stats] chart rendering failed:', err)
      }
    }
    const components = ownZone
      ? []
      : [
          new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(`${TZ_PICKER}:${playerId}`)
              .setPlaceholder('🕐 What time is it for you? (sets your time zone)')
              .addOptions(quickPickZones(locale))
          ),
        ]
    return { embeds: [embed], files, components, allowedMentions: { parse: [] as const } }
  }

  /** The "what time is it for you?" picker under /stats. */
  async #onTimeZonePick(i: StringSelectMenuInteraction) {
    const zone = i.values[0]
    const playerId = i.customId.slice(TZ_PICKER.length + 1)
    if (!zone || !isValidTimeZone(zone)) return
    this.#store.setUserSetting(i.user.id, 'timezone', zone)
    const saved = `Time zone set to **${zone}** (now ${localTime(zone)}). Change it any time with /timezone.`
    // Your own (ephemeral) /stats: redraw it in your time. Someone else's public one stays as it is.
    if (i.message.flags.has(MessageFlags.Ephemeral)) {
      // attachments: [] drops the old chart image (edits keep attachments unless told otherwise).
      await i.update({ content: saved, attachments: [], ...(await this.#statsMessage(playerId, i.user.id, i.locale)) })
    } else {
      await i.reply({ content: `${saved} Run /stats again to see it in your time.`, flags: MessageFlags.Ephemeral })
    }
  }

  #modelLine(): string {
    const m = this.#predictor.model
    const bands = m.instaqueue.map(([lo, hi]) => `${lo}–${hi}`).join(', ') || 'none'
    return `Model: +${+m.searchIncrement.toFixed(2)} MMR range per ${m.tickMs / 1000}s from ${m.searchStart} (${this.#predictor.modelSource}) · instaqueue ${bands}`
  }

  /** The current opponent of a player, if they're in a game (for name resolution). */
  #opponentOf(id: string): string[] {
    const s = this.#player(id)?.snapshot
    return s?.kind === 'in_game' ? [s.opponentId] : []
  }

  #stateLine(id: string): string {
    const s = this.#player(id)?.snapshot
    if (!s) return '❔ not checked yet'
    if (s.kind === 'queuing') return `🟢 queuing · ${ts(s.since)}`
    if (s.kind === 'in_game') return `⚔️ vs ${this.#label(s.opponentId)} · ${ts(s.startTime)}`
    return '💤 idle'
  }

  #matchLine(r: { player_a: string; player_b: string; started_at: number; ended_at: number | null; winner_id: string | null; match_id: number | null }): string {
    const [a, b] = r.winner_id === r.player_b ? [r.player_b, r.player_a] : [r.player_a, r.player_b]
    const vs = r.winner_id ? `${this.#label(a)} beat ${this.#label(b)}` : `${this.#label(a)} vs ${this.#label(b)}`
    const status = r.ended_at === null ? 'playing' : r.winner_id ? `#${r.match_id}` : 'no result'
    return `• ${vs} · ${status} · ${ts(r.started_at)}`
  }
}

/**
 * Names that can't safely be masked-link text:
 *  - emoji, flags and invisible formatting characters (zero-width joiners,
 *    variation selectors, bidi controls): Discord shows the link as raw markdown;
 *  - markdown characters: they'd need escaping, but Discord shows backslash
 *    escapes inside link text literally ("Blued\_"), while unescaped they can
 *    turn into formatting ("_cool_" in italics).
 */
const UNLINKABLE = /[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Cf}︀-️*_~|`\\]/u

/**
 * "**bacon** (#1 · 1624)" with the name linking to the profile. If the name
 * can't be link text, it stays plain and the link moves onto the meta part
 * (or a ↗ when there is none), so every player still gets a working link.
 */
export function playerLabel(name: string, url: string, meta?: string): string {
  // Brackets in a name would break the masked link.
  const safe = escapeMarkdown(name.replace(/[[\]]/g, ''))
  if (!UNLINKABLE.test(name)) return `[**${safe}**](<${url}>)${meta ? ` (${meta})` : ''}`
  return `**${safe}** [${meta ? `(${meta})` : '↗'}](<${url}>)`
}

/** Discord's message length limit. */
const MAX_MESSAGE_LENGTH = 2000

/**
 * Packs lines into as few messages as possible without splitting a line
 * (unless a single line is itself over the limit).
 */
export function chunkLines(lines: string[], max = MAX_MESSAGE_LENGTH): string[] {
  const chunks: string[] = []
  let current = ''
  for (const line of lines.flatMap((l) => (l.length > max ? l.match(new RegExp(`[^]{1,${max}}`, 'g'))! : [l]))) {
    const next = current ? `${current}\n${line}` : line
    if (next.length > max) {
      chunks.push(current)
      current = line
    } else {
      current = next
    }
  }
  if (current) chunks.push(current)
  return chunks
}
