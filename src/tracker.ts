import { EventEmitter } from 'node:events'
import { type Api, HttpError, type LeaderboardEntry, MAX_BATCH_SIZE } from './api.ts'
import type { Config } from './config.ts'
import { findResult, type MatchRecord } from './results.ts'
import type { RecentGame } from './widgets.ts'
import { normalize, SAME_MATCH_TOLERANCE_MS, type Snapshot, transitions } from './state.ts'

export type Tier = 'hot' | 'warm' | 'cold'

export type Player = {
  id: string
  name?: string
  /** 1-based MMR position on the leaderboard, if within the tracked scope. */
  rank?: number
  /** Leaderboard rank of a player outside the tracked scope (display only). */
  globalRank?: number
  mmr?: number
  /**
   * Current streak: positive = wins in a row, negative = losses in a row
   * (from the leaderboard, kept up to date with results we see).
   */
  streak?: number
  /** Their last few games we saw finish with a result, oldest first (for tilt detection). */
  recentGames?: RecentGame[]
  /** wins + losses at the last leaderboard refresh; deltas mark activity. */
  games?: number
  lastActiveAt?: number
  hotUntil?: number
  /** undefined = not observed yet (next observation is a silent baseline). */
  snapshot?: Snapshot
  lastPolledAt: number
}

export type TrackedMatch = {
  /** Sorted pair of Discord user ids. */
  players: [string, string]
  startTime: number
  detectedAt: number
  /** True if we only saw it after it was already running (startup / cold rotation). */
  late: boolean
  /** match_start was emitted for it (at most once). */
  announced?: boolean
  /** Players whose queue phase we never observed (queue→match within one poll). */
  unseenQueue: Set<string>
  /** Queue join time of players we did see queuing right before this match. */
  queueJoins: Map<string, number>
  endedAt?: number
  /** Ended by our timeout, not by a state change: it might still be running. */
  timedOut?: boolean
  /** Its result arrived after we had already reported "no result" (a timed-out match that did finish). */
  lateResult?: boolean
  /** Players the site still shows in this match after we ended it (cancelled matches are never cleared). */
  lingering?: Set<string>
  /** Set by the bot once it has announced the outcome. */
  resultReported?: boolean
}

export type MatchOutcome =
  | { status: 'found'; result: MatchRecord }
  /** Match history answered but has no such match: almost always a cancelled game. */
  | { status: 'not_found' }
  /** Match history could not be reached for any lookup attempt. */
  | { status: 'unavailable' }

type TrackerEvents = {
  queue_join: [{ playerId: string; since: number }]
  queue_leave: [{ playerId: string; since: number }]
  match_start: [TrackedMatch]
  match_end: [TrackedMatch]
  match_result: [TrackedMatch, MatchOutcome]
  /** A poll round was applied (new players may need names). */
  round: []
}
/** Retry schedule for looking up a finished match in the site's match history (first one immediately). */
const RESULT_LOOKUP_DELAYS_MS = [0, 20_000, 90_000, 300_000]

/**
 * How a match was seen to end, which decides how sure one history miss makes us.
 *
 * The queue bot writes a match's result before it closes the match and tells
 * the site, and its history only lists completed matches. A player can only
 * requeue once their match is closed.
 *  - moved_on: a player requeued or started another match → the match is
 *    closed, so one miss means it was cancelled.
 *  - cleared:  the site cleared their state, which only happens for completed
 *    matches → found right away; a second look is just a safety net.
 *  - timeout:  it still shows as running but has gone on too long → likely
 *    cancelled (never cleared on the site); two misses settle it.
 */
export type EndReason = 'moved_on' | 'cleared' | 'timeout'
const MISSES_FOR_NOT_FOUND: Record<EndReason, number> = { moved_on: 1, cleared: 2, timeout: 2 }

/**
 * When to give up on a match that still shows as running: cancelled matches
 * are never cleared on the site. Learned from how long completed matches
 * actually took (p99 × 1.25, between 30 min and the hard stale limit); until
 * there are enough of those, the configured fallback.
 */
export function adaptiveMatchTimeout(durationsMs: number[], fallbackMs: number, maxMs: number): number {
  const MIN_SAMPLES = 30
  const MIN_MS = 30 * 60_000
  if (durationsMs.length < MIN_SAMPLES) return Math.min(fallbackMs, maxMs)
  const sorted = [...durationsMs].sort((a, b) => a - b)
  const p99 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))]!
  return Math.min(maxMs, Math.max(MIN_MS, p99 * 1.25))
}
const MAX_BACKOFF_MS = 5 * 60_000
/** Games kept per player in Player.recentGames. */
const RECENT_GAMES = 10

/**
 * Polls player states in tiers and turns state changes into match-level events.
 *
 *   hot  – queuing / in game / active within hotCooldown (+ opponents) → every hotInterval
 *   warm – top-ranked, subscribed, or played recently                  → every warmInterval
 *   cold – rest of the leaderboard scope → never scheduled; fills spare slots
 *          in requests that are being made anyway (a batch costs one request
 *          whether it carries 10 players or 100).
 */
export class Tracker extends EventEmitter<TrackerEvents> {
  readonly players = new Map<string, Player>()
  readonly activeMatches = new Set<TrackedMatch>()
  lastLeaderboardAt = 0
  lastPollAt = 0
  /** Players on the season leaderboard (for "top X%"). */
  leaderboardTotal: number | undefined
  paused = false

  readonly #api: Api
  readonly #cfg: Config
  readonly #isWatched: (id: string) => boolean
  readonly #hasConsumers: () => boolean
  readonly #history: (userId: string) => Promise<MatchRecord[]>
  readonly #matchTimeoutMs: () => number
  readonly #wasEnded: (a: string, b: string, startTime: number) => boolean
  /** Matches we ended that the site may still show as running (see TrackedMatch.lingering). */
  readonly #ended = new Set<TrackedMatch>()
  #timers = new Set<NodeJS.Timeout>()
  #pollTimer: NodeJS.Timeout | undefined
  #nextPollAt = 0
  #lastTickAt = 0
  #ticking = false
  #forceNext = false
  #pollFailures = 0
  #stopped = false
  #warmTop: number

  constructor(opts: {
    api: Api
    config: Config
    /** Players someone subscribed to: always at least warm. */
    isWatched: (id: string) => boolean
    /** If nobody would receive events, skip state polling entirely. */
    hasConsumers: () => boolean
    /** A player's recent match history, for looking up results. */
    history?: (userId: string) => Promise<MatchRecord[]>
    /** How long a match may show as running before we treat it as over (see adaptiveMatchTimeout). */
    matchTimeoutMs?: () => number
    /** Whether a match was already settled earlier (e.g. before a restart); players sorted. */
    wasEnded?: (a: string, b: string, startTime: number) => boolean
  }) {
    super()
    this.#api = opts.api
    this.#cfg = opts.config
    this.#isWatched = opts.isWatched
    this.#hasConsumers = opts.hasConsumers
    this.#history = opts.history ?? (async () => [])
    this.#matchTimeoutMs = opts.matchTimeoutMs ?? (() => this.#cfg.staleMatchMs)
    this.#wasEnded = opts.wasEnded ?? (() => false)
    this.#warmTop = this.#cfg.topN === 0 ? 100 : this.#cfg.topN
  }

  // ---------------------------------------------------------------- lifecycle

  async start() {
    await this.#leaderboardLoop()
    this.#pollLoop()
  }

  stop() {
    this.#stopped = true
    for (const t of this.#timers) clearTimeout(t)
    this.#timers.clear()
    if (this.#pollTimer) clearTimeout(this.#pollTimer)
  }

  #later(ms: number, fn: () => void) {
    if (this.#stopped) return
    const t = setTimeout(() => {
      this.#timers.delete(t)
      fn()
    }, ms)
    this.#timers.add(t)
  }

  // -------------------------------------------------------------- leaderboard

  async #leaderboardLoop() {
    try {
      this.applyLeaderboard(await this.#api.fetchLeaderboard(this.#cfg.queueId, this.#cfg.topN), Date.now())
      this.leaderboardTotal = this.#api.leaderboardTotal
    } catch (err) {
      console.error('[tracker] leaderboard refresh failed:', describe(err))
    }
    this.#later(this.#cfg.leaderboardRefreshMs, () => void this.#leaderboardLoop())
  }

  applyLeaderboard(entries: LeaderboardEntry[], now: number) {
    const seen = new Set<string>()
    entries.forEach((entry, i) => {
      seen.add(entry.id)
      const p = this.#player(entry.id)
      const games = entry.wins + entry.losses
      // Someone finished a game since the last refresh: they're in a session,
      // so promote them to warm even if we never caught them live.
      if (p.games !== undefined && games > p.games) p.lastActiveAt = now
      p.games = games
      p.name = entry.name
      p.mmr = entry.mmr
      p.streak = entry.streak
      p.rank = i + 1
    })
    for (const p of this.players.values()) {
      if (!seen.has(p.id)) p.rank = undefined
    }
    this.lastLeaderboardAt = now
    this.#prune(now)
  }

  // -------------------------------------------------------------------- tiers

  tier(p: Player, now: number): Tier {
    if ((p.snapshot && p.snapshot.kind !== 'idle') || (p.hotUntil ?? 0) > now) return 'hot'
    if (
      (p.rank !== undefined && p.rank <= this.#warmTop) ||
      this.#isWatched(p.id) ||
      (p.lastActiveAt !== undefined && now - p.lastActiveAt < this.#cfg.warmWindowMs)
    ) {
      return 'warm'
    }
    return 'cold'
  }

  /** Cold players outside the leaderboard scope have no reason to be kept. */
  #prune(now: number) {
    for (const p of this.players.values()) {
      if (p.rank === undefined && this.tier(p, now) === 'cold') this.players.delete(p.id)
    }
  }

  #player(id: string): Player {
    let p = this.players.get(id)
    if (!p) {
      p = { id, lastPolledAt: 0 }
      this.players.set(id, p)
    }
    return p
  }

  /** Make sure a player is polled on the next tick (e.g. a newly seen opponent or a new subscription). */
  heat(id: string, now = Date.now()) {
    const p = this.#player(id)
    p.hotUntil = Math.max(p.hotUntil ?? 0, now + this.#cfg.hotCooldownMs)
  }

  /** Picks who to poll this tick. Exported for tests via the public method. */
  /** Who to poll now; `force`: every hot and warm player, due or not (after a trigger). */
  selectBatch(now: number, force = false): string[] {
    const hotDue = force ? 0 : this.#cfg.hotIntervalMs * 0.8 // absorb timer jitter
    const warmDue = force ? 0 : this.#cfg.warmIntervalMs * 0.9
    const due: Player[] = []
    const rest: Player[] = []
    for (const p of this.players.values()) {
      const age = now - p.lastPolledAt
      const tier = this.tier(p, now)
      if ((tier === 'hot' && age >= hotDue) || (tier === 'warm' && age >= warmDue)) due.push(p)
      else rest.push(p)
    }
    if (due.length === 0) return []

    // Fill the request(s) we're about to make anyway with the stalest others.
    const capacity = Math.ceil(due.length / MAX_BATCH_SIZE) * MAX_BATCH_SIZE
    rest.sort((a, b) => a.lastPolledAt - b.lastPolledAt)
    return [...due, ...rest.slice(0, capacity - due.length)].map((p) => p.id)
  }

  // --------------------------------------------------------------------- poll

  #pollLoop() {
    this.#pollTimer = undefined
    this.#ticking = true
    this.#lastTickAt = Date.now()
    const force = this.#forceNext
    this.#forceNext = false
    let delay = this.#cfg.hotIntervalMs
    this.#tick(force)
      .catch((err) => {
        this.#pollFailures++
        const backoff = Math.min(MAX_BACKOFF_MS, this.#cfg.hotIntervalMs * 2 ** this.#pollFailures)
        delay = Math.max(backoff, err instanceof HttpError ? (err.retryAfterMs ?? 0) : 0)
        console.error(`[tracker] poll failed (${this.#pollFailures}x), retrying in ${delay / 1000}s:`, describe(err))
      })
      .finally(() => {
        this.#ticking = false
        this.#schedulePoll(delay)
      })
  }

  #schedulePoll(delay: number) {
    if (this.#stopped) return
    if (this.#pollTimer) clearTimeout(this.#pollTimer)
    this.#nextPollAt = Date.now() + delay
    this.#pollTimer = setTimeout(() => this.#pollLoop(), delay)
  }

  /**
   * Something happened (a match started or ended somewhere): poll every hot
   * and warm player on the next tick, and pull that tick forward, though
   * never closer to the previous one than the speed setting's hot interval.
   * So triggers make detection quicker without raising the request rate.
   */
  pollSoon() {
    this.#forceNext = true
    if (this.#ticking || this.#stopped) return // the forced poll follows this one
    const at = Math.max(Date.now() + 500, this.#lastTickAt + this.#cfg.hotIntervalMs)
    if (this.#pollTimer && this.#nextPollAt <= at) return // already due sooner
    this.#schedulePoll(at - Date.now())
  }

  async #tick(force = false) {
    const now = Date.now()
    if (!this.#hasConsumers()) {
      if (!this.paused) console.log('[tracker] nobody subscribed and no feed channel: pausing state polling')
      this.paused = true
      return
    }
    if (this.paused) {
      // Snapshots are outdated; re-baseline instead of inventing transitions.
      for (const p of this.players.values()) p.snapshot = undefined
      this.activeMatches.clear()
      this.#ended.clear()
      this.paused = false
      console.log('[tracker] resuming state polling')
    }

    this.checkTimeouts(now)

    const ids = this.selectBatch(now, force)
    if (ids.length === 0) return
    const states = await this.#api.fetchStates(ids)
    this.#pollFailures = 0
    this.lastPollAt = now
    this.observe(states, now)
  }

  /** Ends matches that have shown as running for too long (cancelled ones are never cleared on the site). */
  checkTimeouts(now: number) {
    const timeoutMs = this.#matchTimeoutMs()
    for (const m of this.activeMatches) {
      if (now - m.startTime > timeoutMs) this.#endMatch(m, now, 'timeout')
    }
    for (const m of this.#ended) {
      if (now - m.startTime > this.#cfg.staleMatchMs) this.#ended.delete(m)
    }
  }

  /** Applies one round of observations. Public so it can be driven in tests. */
  observe(states: Map<string, Parameters<typeof normalize>[0]>, now: number) {
    const started = new Set<TrackedMatch>()

    for (const [id, remote] of states) {
      const p = this.#player(id)
      const shown = normalize(remote, now, this.#cfg)
      let next = shown
      // The site never clears cancelled matches, so it can keep showing a
      // match we already ended (the opponent moved on, or it timed out).
      for (const m of this.#ended) {
        if (!m.lingering?.has(id)) continue
        if (shown.kind === 'in_game' && this.#isMatch(m, id, shown.opponentId, shown.startTime)) {
          next = { kind: 'idle' } // over: don't keep them "in game" or re-announce it
          continue
        }
        // The site moved on from it for this player.
        m.lingering.delete(id)
        if (m.lingering.size === 0) this.#ended.delete(m)
        if (m.timedOut && !m.lateResult) {
          // We gave up on it, yet it really ended now: it may have finished after all.
          m.lateResult = true
          m.endedAt = now
          this.#lookupResult(m, shown.kind === 'idle' ? 'cleared' : 'moved_on', { onlyIfFound: true })
        }
      }
      const prev = p.snapshot
      p.snapshot = next
      p.lastPolledAt = now

      if (!prev) {
        // Baseline: don't announce what was already going on, but remember
        // running matches so we can still report their results.
        if (next.kind === 'in_game') {
          const [a, b] = [id, next.opponentId].sort() as [string, string]
          if (this.#wasEnded(a, b, next.startTime)) {
            // Settled before (typically a cancelled match the site never
            // cleared, seen again after a restart): it's over, stay quiet.
            this.#rememberEnded(a, b, next.startTime, now)
            p.snapshot = { kind: 'idle' }
          } else {
            this.#registerMatch(id, next.opponentId, next.startTime, now, true)
          }
        }
        continue
      }

      for (const t of transitions(prev, next)) {
        switch (t.type) {
          case 'queue_join':
            this.emit('queue_join', { playerId: id, since: t.since })
            break
          case 'queue_leave':
            p.hotUntil = now + this.#cfg.hotCooldownMs
            this.emit('queue_leave', { playerId: id, since: t.since })
            break
          case 'match_start': {
            const m = this.#registerMatch(id, t.opponentId, t.startTime, now, false)
            if (!t.sawQueue) m.unseenQueue.add(id)
            else if (prev.kind === 'queuing') m.queueJoins.set(id, prev.since)
            // Once per match: the two players are often seen going in on
            // different polls (e.g. one was queuing and polled more often).
            if (!m.announced) {
              m.announced = true
              started.add(m)
            }
            this.heat(t.opponentId, now)
            break
          }
          case 'match_end': {
            p.hotUntil = now + this.#cfg.hotCooldownMs
            p.lastActiveAt = now
            const m = this.#findMatch(id, t.opponentId, t.startTime)
            if (m) this.#endMatch(m, now, next.kind === 'idle' ? 'cleared' : 'moved_on')
            break
          }
        }
      }
    }

    // Emitted after the whole round so both players' views are merged first.
    for (const m of started) this.emit('match_start', m)
    this.emit('round')
  }

  // ------------------------------------------------------------------ matches

  #isMatch(m: TrackedMatch, a: string, b: string, startTime: number): boolean {
    return m.players.includes(a) && m.players.includes(b) && Math.abs(m.startTime - startTime) < SAME_MATCH_TOLERANCE_MS
  }

  #findMatch(a: string, b: string, startTime: number): TrackedMatch | undefined {
    for (const m of this.activeMatches) {
      if (this.#isMatch(m, a, b, startTime)) return m
    }
    return undefined
  }

  #registerMatch(a: string, b: string, startTime: number, now: number, late: boolean): TrackedMatch {
    const existing = this.#findMatch(a, b, startTime)
    if (existing) return existing
    const m: TrackedMatch = {
      players: [a, b].sort() as [string, string],
      startTime,
      detectedAt: now,
      // A match first noticed long after it began came from a cold player
      // rotating in or a restart; don't present it as "just started".
      late: late || now - startTime > this.#cfg.warmIntervalMs * 2,
      unseenQueue: new Set(),
      queueJoins: new Map(),
    }
    this.activeMatches.add(m)
    return m
  }

  /**
   * Keeps streaks current between leaderboard refreshes (which overwrite these
   * with the real values). Mirrors the queue bot: positive = wins in a row,
   * negative = losses in a row, and a result in the other direction restarts
   * at ±1.
   */
  #applyToStreaks(m: TrackedMatch, result: MatchRecord) {
    const [winner, loser] = result.won ? m.players : [m.players[1], m.players[0]]
    const w = this.players.get(winner)
    const l = this.players.get(loser)
    if (w?.streak !== undefined) w.streak = w.streak > 0 ? w.streak + 1 : 1
    if (l?.streak !== undefined) l.streak = l.streak < 0 ? l.streak - 1 : -1
    for (const [p, won] of [
      [w, true],
      [l, false],
    ] as const) {
      if (!p) continue
      const games = (p.recentGames ??= [])
      // When they queued for it if we saw that, else when it started.
      games.push({ queuedAt: m.queueJoins.get(p.id) ?? m.startTime, endedAt: m.endedAt ?? Date.now(), won })
      if (games.length > RECENT_GAMES) games.shift()
    }
  }

  /** Marks a match as already over without any events, so the site showing it as running is ignored. */
  #rememberEnded(a: string, b: string, startTime: number, now: number) {
    for (const m of this.#ended) {
      if (this.#isMatch(m, a, b, startTime)) return
    }
    this.#ended.add({
      players: [a, b],
      startTime,
      detectedAt: now,
      endedAt: now,
      late: true,
      unseenQueue: new Set(),
      queueJoins: new Map(),
      lingering: new Set([a, b]),
      resultReported: true,
    })
  }

  #endMatch(m: TrackedMatch, now: number, reason: EndReason) {
    if (!this.activeMatches.delete(m)) return
    m.endedAt = now
    m.timedOut = reason === 'timeout'
    m.lingering = new Set(m.players)
    this.#ended.add(m)
    this.emit('match_end', m)
    this.#lookupResult(m, reason)
  }

  /**
   * Looks the match up in the history until it's found, or until enough clean
   * misses for this end reason say there is no result. `onlyIfFound`: a
   * second-chance lookup that stays silent unless the result turns up.
   */
  #lookupResult(m: TrackedMatch, reason: EndReason, opts: { onlyIfFound?: boolean } = {}, attempt = 0, misses = 0) {
    const delay = RESULT_LOOKUP_DELAYS_MS[attempt]
    if (delay === undefined || misses >= MISSES_FOR_NOT_FOUND[reason]) {
      if (!opts.onlyIfFound) this.emit('match_result', m, { status: misses > 0 ? 'not_found' : 'unavailable' })
      return
    }
    this.#later(delay, async () => {
      try {
        const result = findResult(await this.#history(m.players[0]), m)
        if (result) {
          this.#applyToStreaks(m, result)
          this.emit('match_result', m, { status: 'found', result })
          return
        }
        misses++
      } catch (err) {
        console.error('[tracker] result lookup failed:', describe(err))
      }
      this.#lookupResult(m, reason, opts, attempt + 1, misses)
    })
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.cause instanceof Error ? `${err.message} (${err.cause.message})` : err.message
  return String(err)
}
