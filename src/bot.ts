import {
  ApplicationIntegrationType,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  Client,
  DiscordAPIError,
  Events,
  escapeMarkdown,
  GatewayIntentBits,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  type SlashCommandStringOption,
} from 'discord.js'
import type { Api } from './api.ts'
import type { Config } from './config.ts'
import { describeMask, NOTIFY_ALL, Notify, type NotifyKind, type Store } from './db.ts'
import { formatDuration } from './matchmaking.ts'
import type { Directory } from './directory.ts'
import type { Forecast, Predictor, ViewerForecast } from './predict.ts'
import type { MatchOutcome, Player, TrackedMatch, Tracker } from './tracker.ts'

const ts = (ms: number, style: 'R' | 't' | 'f' = 'R') => `<t:${Math.floor(ms / 1000)}:${style}>`

const NOTIFY_CHOICES = [
  { name: 'Everything (queue, match found, result)', value: 'all' },
  { name: 'Joins the queue', value: 'queue' },
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
  command('subscribe', "Get a DM when a player queues, finds a match, or finishes a game")
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
  command('about', 'How tracklatro works and what it is tracking'),
]

export class Bot {
  readonly client = new Client({ intents: [GatewayIntentBits.Guilds] })
  readonly #cfg: Config
  readonly #store: Store
  readonly #tracker: Tracker
  readonly #api: Api
  readonly #predictor: Predictor
  readonly #directory: Directory
  readonly #startedAt = Date.now()

  constructor(opts: {
    config: Config
    store: Store
    tracker: Tracker
    api: Api
    predictor: Predictor
    directory: Directory
  }) {
    this.#cfg = opts.config
    this.#store = opts.store
    this.#tracker = opts.tracker
    this.#api = opts.api
    this.#predictor = opts.predictor
    this.#directory = opts.directory
    // Players who aren't ranked this season still have a Discord name.
    this.#directory.discordName = async (id) => {
      const user = await this.client.users.fetch(id)
      return user.globalName ?? user.username
    }

    this.client.once(Events.ClientReady, async (c) => {
      console.log(`[bot] logged in as ${c.user.tag}`)
      const body = COMMANDS.map((cmd) => cmd.toJSON())
      if (this.#cfg.guildId) await c.application.commands.set(body, this.#cfg.guildId)
      else await c.application.commands.set(body)
      console.log(`[bot] registered ${body.length} commands ${this.#cfg.guildId ? `in guild ${this.#cfg.guildId}` : 'globally'}`)
    })
    this.client.on(Events.InteractionCreate, async (i) => {
      try {
        if (i.isAutocomplete()) await this.#autocomplete(i)
        else if (i.isChatInputCommand()) await this.#command(i)
      } catch (err) {
        console.error('[bot] interaction failed:', err)
        if (i.isRepliable() && !i.replied) {
          await i.reply({ content: 'Something went wrong.', flags: MessageFlags.Ephemeral }).catch(() => {})
        }
      }
    })

    this.#tracker.on('queue_join', (e) => void this.#onQueueJoin(e.playerId, e.since))
    this.#tracker.on('match_start', (m) => void this.#onMatchStart(m))
    this.#tracker.on('match_result', (m, r) => void this.#onMatchResult(m, r))
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
        ? ` (#${rank} · ${Math.round(mmr)})`
        : mmr !== undefined
          ? ` (${Math.round(mmr)})`
          : ''
    // Brackets in a name would break the masked link.
    const safe = escapeMarkdown(this.#name(id).replace(/[[\]]/g, ''))
    return `[**${safe}**](<${this.#cfg.siteUrl}/players/${id}>)${meta}`
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

  async #dm(userId: string, content: string) {
    try {
      await this.client.users.send(userId, { content, allowedMentions: { parse: [] } })
    } catch (err) {
      const reason = err instanceof DiscordAPIError && err.code === 50007 ? 'DMs closed' : String(err)
      console.warn(`[bot] could not DM ${userId}: ${reason}`)
    }
  }

  async #feed(content: string) {
    if (!this.#cfg.feedChannelId) return
    try {
      const channel = await this.client.channels.fetch(this.#cfg.feedChannelId)
      if (channel?.isSendable()) await channel.send({ content, allowedMentions: { parse: [] } })
    } catch (err) {
      console.warn('[bot] feed post failed:', err)
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

  async #onQueueJoin(playerId: string, since: number) {
    await this.#named([playerId], 5_000)
    const msg = `🟡 ${this.#label(playerId)} joined the queue ${ts(since)}.`
    const recipients = this.#recipients([playerId], (mask) => (mask & Notify.queue) !== 0)
    // Forecasts only cost requests when someone will actually read them.
    const forecast = recipients.size
      ? await this.#predictor.forecast(playerId, [...recipients]).catch((err) => {
          console.warn('[bot] forecast failed:', err)
          return null
        })
      : null
    await Promise.all([
      ...[...recipients].map((userId) =>
        this.#dm(userId, forecast ? [msg, ...this.#forecastLines(forecast.base, forecast.viewers.get(userId))].join('\n') : msg)
      ),
      this.#featured([playerId]) ? this.#feed(msg) : undefined,
    ])
  }

  // ---------------------------------------------------------------- forecasts

  #forecastLines(f: Forecast, you?: ViewerForecast): string[] {
    const now = Date.now()
    const ifQueued = f.targetQueuing ? '' : 'if they queued now, '
    const others = `${f.visibleOthers} other${f.visibleOthers === 1 ? '' : 's'} visible in queue${f.unseen ? ` (+${f.unseen} I can't see)` : ''}`
    const lines: string[] = []

    if (f.likely) {
      const gap = Math.round(Math.abs(f.likely.opponentMmr - f.targetMmr))
      lines.push(
        `🔮 Likely opponent ${ifQueued}${this.#label(f.likely.opponent)}, gap ${gap} MMR, in ~${formatDuration(f.likely.at - now)} — ${others}.`
      )
    } else {
      lines.push(`🔮 Nobody I can see in the queue would get paired with them soon — ${others}.`)
    }

    if (you?.kind === 'estimate') {
      const who = `you ${Math.round(you.mmr)} vs ${Math.round(f.targetMmr)}, gap ${Math.round(you.gap)}${you.instaqueue ? ', both in an instaqueue band' : ''}`
      const when = f.targetQueuing ? 'If you queue now' : 'If you both queued now'
      if (you.outcome?.opponent === undefined || you.outcome.opponent === f.targetId) {
        // Simulated pairing between the two of you (or nobody else in the way).
        lines.push(`🎯 ${when}, you'd likely get them in ~${formatDuration((you.outcome?.at ?? you.pairableAt) - now)} (${who}).`)
      } else {
        lines.push(
          `🎯 ${when}, you'd be in range of each other after ~${formatDuration(you.pairableAt - now)} (${who}), ` +
            `but they'd likely be paired with ${this.#label(you.outcome.opponent)} first (~${formatDuration(you.outcome.at - now)}).`
        )
      }
    } else if (you?.kind === 'unranked') {
      lines.push("🎯 I couldn't find your ranked MMR, so there's no personal estimate.")
    } else if (you?.kind === 'busy') {
      lines.push(you.status === 'in_game' ? "🎯 You're in a game right now." : "🎯 You're already queuing; you're included above.")
    }

    lines.push("-# Speculation from Botlatro's matchmaking rules and the queue I can see; anyone joining or leaving changes it.")
    return lines
  }

  async #onMatchStart(m: TrackedMatch) {
    const [a, b] = m.players
    this.#store.logMatchStart(a, b, m.startTime)
    await this.#named(m.players, 5_000)
    const when = m.late ? `started ${ts(m.startTime)} (noticed late)` : `started ${ts(m.startTime)}`
    const msg = `⚔️ ${this.#label(a)} vs ${this.#label(b)} — match ${when}.`
    await Promise.all([
      this.#notify(
        m.players,
        // Queue-only subscribers still hear about it if the queue phase was
        // too short for us to see: from their point of view, they queued.
        (mask, target) => (mask & Notify.match) !== 0 || ((mask & Notify.queue) !== 0 && m.unseenQueue.has(target)),
        msg
      ),
      this.#featured(m.players) && !m.late ? this.#feed(msg) : undefined,
    ])
  }

  async #onMatchResult(m: TrackedMatch, outcome: MatchOutcome) {
    const [a, b] = m.players
    const ended = m.endedAt ?? Date.now()
    await this.#named(m.players, 5_000)
    let msg: string
    if (outcome.status !== 'found') {
      this.#store.logMatchResult(a, b, m.startTime, ended, null, null)
      msg =
        outcome.status === 'not_found'
          ? `⚪ ${this.#label(a)} vs ${this.#label(b)} ended ${ts(ended)} without a recorded result (probably cancelled).`
          : `⚪ ${this.#label(a)} vs ${this.#label(b)} ended ${ts(ended)}; the result couldn't be fetched (match history unavailable).`
    } else {
      const r = outcome.result
      // r is from a's perspective.
      const opp = r.opponents.find((o) => o.user_id === b)
      const aWon = r.won
      const [winner, loser] = aWon ? [a, b] : [b, a]
      const delta = (id: string) => {
        const v = id === a ? r.elo_change : (opp?.elo_change ?? 0)
        return `${v >= 0 ? '+' : ''}${v.toFixed(1)}`
      }
      this.#store.logMatchResult(a, b, m.startTime, ended, r.match_id, winner)
      const details = [r.deck, r.stake, r.best_of_5 ? 'Bo5' : r.best_of_3 ? 'Bo3' : null].filter(Boolean).join(' · ')
      msg =
        `🏆 ${this.#label(winner)} beat ${this.#label(loser)} ` +
        `(${delta(winner)} / ${delta(loser)})${details ? ` — ${details}` : ''} · match #${r.match_id}, ended ${ts(ended)}.`
    }
    await Promise.all([
      this.#notify(m.players, (mask) => (mask & Notify.result) !== 0, msg),
      this.#featured(m.players) ? this.#feed(msg) : undefined,
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
    await i.respond(choices)
  }

  async #command(i: ChatInputCommandInteraction) {
    const reply = (content: string) =>
      i.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } })

    switch (i.commandName) {
      case 'subscribe': {
        const id = this.#resolvePlayer(i.options.getString('player', true))
        if (!id) return reply("I don't know that player. Pick one from the suggestions, or paste their Discord user id.")
        if (id === i.user.id) return reply("You'll already know when you queue. 🙂")
        const existing = this.#store.subscriptionsOf(i.user.id)
        if (!existing.some((s) => s.target_id === id) && existing.length >= this.#cfg.maxSubscriptionsPerUser) {
          return reply(`You can follow at most ${this.#cfg.maxSubscriptionsPerUser} players. Use /unsubscribe first.`)
        }
        const mask = this.#store.subscribe(i.user.id, id, maskFromChoice(i.options.getString('notify')))
        this.#tracker.heat(id) // poll them right away so /status is fresh
        const outside = this.#player(id)?.rank === undefined
        await reply(
          `Following ${this.#label(id)} — you'll be DM'd about: **${describeMask(mask)}**.` +
            (outside ? '\n-# This player is outside the tracked leaderboard range; they are tracked because you follow them.' : '')
        )
        // Make sure DMs actually reach them; include how this matchup looks.
        const forecast = await this.#predictor.forecast(id, [i.user.id]).catch(() => null)
        const lines = [`🔔 You're now following ${this.#label(id)} (${describeMask(mask)}).`]
        if (forecast) lines.push(...this.#forecastLines(forecast.base, forecast.viewers.get(i.user.id)))
        try {
          await i.user.send({ content: lines.join('\n'), allowedMentions: { parse: [] } })
        } catch {
          await i.followUp({
            content: "⚠️ I couldn't DM you. Enable DMs from server members (or add me as a user app), otherwise you won't receive notifications.",
            flags: MessageFlags.Ephemeral,
          })
        }
        return
      }

      case 'unsubscribe': {
        const id = this.#resolvePlayer(i.options.getString('player', true))
        if (!id || !this.#store.subscribersOf(id).has(i.user.id)) return reply("You aren't following that player.")
        const remaining = this.#store.unsubscribe(i.user.id, id, maskFromChoice(i.options.getString('notify')))
        return reply(
          remaining === 0
            ? `Stopped following ${this.#label(id)}.`
            : `Updated: you'll still be DM'd about **${describeMask(remaining)}** for ${this.#label(id)}.`
        )
      }

      case 'subscriptions': {
        const subs = this.#store.subscriptionsOf(i.user.id)
        if (subs.length === 0) return reply('You are not following anyone. Use /subscribe.')
        await this.#named(subs.flatMap((s) => [s.target_id, ...this.#opponentOf(s.target_id)]))
        return reply(
          subs.map((s) => `• ${this.#label(s.target_id)} — ${describeMask(s.mask)} · ${this.#stateLine(s.target_id)}`).join('\n')
        )
      }

      case 'status': {
        const id = this.#resolvePlayer(i.options.getString('player', true))
        if (!id) return reply("I don't know that player.")
        const p = this.#player(id)
        const recent = this.#store.recentMatches(3, id)
        await this.#named([id, ...this.#opponentOf(id), ...recent.flatMap((r) => [r.player_a, r.player_b])])
        const lines = [`${this.#label(id)}: ${this.#stateLine(id)}`]
        if (p?.lastPolledAt) lines.push(`-# last checked ${ts(p.lastPolledAt)} · ${this.#tracker.tier(p, Date.now())} tier`)
        if (recent.length) lines.push('', '**Recent tracked matches**', ...recent.map((r) => this.#matchLine(r)))
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
            ? queuing.map((p) => `• ${this.#label(p.id)} since ${ts(p.snapshot?.kind === 'queuing' ? p.snapshot.since : now)}`)
            : ['-# nobody']),
          '',
          `**In game (${matches.length})**`,
          ...(matches.length
            ? matches.map((m) => `• ${this.#label(m.players[0])} vs ${this.#label(m.players[1])} — ${ts(m.startTime)}`)
            : ['-# nobody']),
        ]
        if (this.#tracker.paused) lines.push('', '-# ⏸️ Polling is paused because nobody is subscribed.')
        return reply(truncate(lines.join('\n')))
      }

      case 'recent': {
        const raw = i.options.getString('player')
        const id = raw ? this.#resolvePlayer(raw) : undefined
        if (raw && !id) return reply("I don't know that player.")
        const rows = this.#store.recentMatches(10, id ?? undefined)
        await this.#named(rows.flatMap((r) => [r.player_a, r.player_b]))
        return reply(rows.length ? truncate(rows.map((r) => this.#matchLine(r)).join('\n')) : 'No tracked matches yet.')
      }

      case 'matchup': {
        const id = this.#resolvePlayer(i.options.getString('player', true))
        if (!id) return reply("I don't know that player.")
        if (id === i.user.id) return reply("You can't queue into yourself. 🙂")
        await i.deferReply({ flags: MessageFlags.Ephemeral })
        const forecast = await this.#predictor.forecast(id, [i.user.id])
        if (!forecast) return i.editReply(`I couldn't find ${this.#label(id)}'s ranked MMR.`)
        const state = this.#player(id)?.snapshot
        const header =
          state?.kind === 'in_game'
            ? `${this.#label(id)} is in a game right now. If they queue again afterwards:`
            : state?.kind === 'queuing'
              ? `${this.#label(id)} has been queuing since ${ts(state.since)}.`
              : `${this.#label(id)} isn't queuing right now. If they did:`
        return i.editReply({
          content: [header, ...this.#forecastLines(forecast.base, forecast.viewers.get(i.user.id))].join('\n'),
          allowedMentions: { parse: [] },
        })
      }

      case 'about': {
        const now = Date.now()
        const tiers = { hot: 0, warm: 0, cold: 0 }
        for (const p of this.#tracker.players.values()) tiers[this.#tracker.tier(p, now)]++
        const hours = Math.max((now - this.#startedAt) / 3_600_000, 1 / 60)
        const { site, botlatro } = this.#api.requestCounts
        return reply(
          [
            '**tracklatro** follows Balatro Multiplayer queue states from balatromp.com.',
            `Tracking **${this.#tracker.players.size}** players (${this.#cfg.topN === 0 ? 'whole leaderboard' : `top ${this.#cfg.topN}`} + followed players):`,
            `• 🔥 hot ${tiers.hot} — checked every ${this.#cfg.hotIntervalMs / 1000}s`,
            `• 🌤️ warm ${tiers.warm} — every ${this.#cfg.warmIntervalMs / 1000}s`,
            `• 🧊 cold ${tiers.cold} — rotated through spare request slots`,
            `Requests: ${site} to the site (~${Math.round(site / hours)}/h), ${botlatro} to Botlatro (~${Math.round(botlatro / hours)}/h).`,
            this.#modelLine(),
            `-# Leaderboard refreshed ${this.#tracker.lastLeaderboardAt ? ts(this.#tracker.lastLeaderboardAt) : 'never'}, last poll ${this.#tracker.lastPollAt ? ts(this.#tracker.lastPollAt) : 'never'}.`,
          ].join('\n')
        )
      }
    }
  }

  #modelLine(): string {
    const m = this.#predictor.model
    const bands = m.instaqueue.map(([lo, hi]) => `${lo}–${hi}`).join(', ') || 'none'
    return (
      `Matchmaking model: range starts at ${m.searchStart} and grows ${+m.searchIncrement.toFixed(2)} MMR per ${m.tickMs / 1000}s ` +
      `(${this.#predictor.modelSource}); instaqueue bands ${bands}.`
    )
  }

  /** The current opponent of a player, if they're in a game (for name resolution). */
  #opponentOf(id: string): string[] {
    const s = this.#player(id)?.snapshot
    return s?.kind === 'in_game' ? [s.opponentId] : []
  }

  #stateLine(id: string): string {
    const s = this.#player(id)?.snapshot
    if (!s) return 'unknown (not checked yet)'
    if (s.kind === 'queuing') return `🟡 queuing since ${ts(s.since)}`
    if (s.kind === 'in_game') return `⚔️ playing ${this.#label(s.opponentId)} since ${ts(s.startTime)}`
    return '💤 idle'
  }

  #matchLine(r: { player_a: string; player_b: string; started_at: number; ended_at: number | null; winner_id: string | null; match_id: number | null }): string {
    const [a, b] = r.winner_id === r.player_b ? [r.player_b, r.player_a] : [r.player_a, r.player_b]
    const vs = r.winner_id ? `${this.#label(a)} beat ${this.#label(b)}` : `${this.#label(a)} vs ${this.#label(b)}`
    const status = r.ended_at === null ? 'in progress' : r.winner_id ? `#${r.match_id}` : 'no result'
    return `• ${ts(r.started_at, 'f')} ${vs} — ${status}`
  }
}

function truncate(s: string, max = 1900): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n…`
}
