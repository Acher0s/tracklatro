import { EventEmitter } from 'node:events'
import { type Api, HttpError, type LeaderboardEntry, MAX_BATCH_SIZE, type PlayerMatch } from './api.ts'
import type { Config } from './config.ts'
import { normalize, type Snapshot, transitions } from './state.ts'

export type Tier = 'hot' | 'warm' | 'cold'

export type Player = {
  id: string
  name?: string
  /** 1-based MMR position on the leaderboard, if within the tracked scope. */
  rank?: number
  /** Leaderboard rank of a player outside the tracked scope (display only). */
  globalRank?: number
  mmr?: number
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
  /** Players whose queue phase we never observed (queue→match within one poll). */
  unseenQueue: Set<string>
  /** Queue join time of players we did see queuing right before this match. */
  queueJoins: Map<string, number>
  endedAt?: number
}

export type MatchOutcome =
  | { status: 'found'; result: PlayerMatch }
  /** Botlatro answered but has no completed match: almost always a cancelled game. */
  | { status: 'not_found' }
  /** Botlatro could not be reached for any lookup attempt. */
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

/** Two observations of the same match from either player differ by a few ms. */
const SAME_MATCH_TOLERANCE_MS = 2 * 60_000
/** Retry schedule for looking up a finished match in Botlatro's history. */
const RESULT_LOOKUP_DELAYS_MS = [5_000, 30_000, 90_000, 300_000]
const MAX_BACKOFF_MS = 5 * 60_000

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
  paused = false

  readonly #api: Api
  readonly #cfg: Config
  readonly #isWatched: (id: string) => boolean
  readonly #hasConsumers: () => boolean
  #timers = new Set<NodeJS.Timeout>()
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
  }) {
    super()
    this.#api = opts.api
    this.#cfg = opts.config
    this.#isWatched = opts.isWatched
    this.#hasConsumers = opts.hasConsumers
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
  selectBatch(now: number): string[] {
    const hotDue = this.#cfg.hotIntervalMs * 0.8 // absorb timer jitter
    const warmDue = this.#cfg.warmIntervalMs * 0.9
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
    let delay = this.#cfg.hotIntervalMs
    this.#tick()
      .catch((err) => {
        this.#pollFailures++
        const backoff = Math.min(MAX_BACKOFF_MS, this.#cfg.hotIntervalMs * 2 ** this.#pollFailures)
        delay = Math.max(backoff, err instanceof HttpError ? (err.retryAfterMs ?? 0) : 0)
        console.error(`[tracker] poll failed (${this.#pollFailures}x), retrying in ${delay / 1000}s:`, describe(err))
      })
      .finally(() => this.#later(delay, () => this.#pollLoop()))
  }

  async #tick() {
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
      this.paused = false
      console.log('[tracker] resuming state polling')
    }

    for (const m of this.activeMatches) {
      if (now - m.startTime > this.#cfg.staleMatchMs) this.#endMatch(m, now)
    }

    const ids = this.selectBatch(now)
    if (ids.length === 0) return
    const states = await this.#api.fetchStates(ids)
    this.#pollFailures = 0
    this.lastPollAt = now
    this.observe(states, now)
  }

  /** Applies one round of observations. Public so it can be driven in tests. */
  observe(states: Map<string, Parameters<typeof normalize>[0]>, now: number) {
    const started = new Set<TrackedMatch>()

    for (const [id, remote] of states) {
      const p = this.#player(id)
      const next = normalize(remote, now, this.#cfg)
      const prev = p.snapshot
      p.snapshot = next
      p.lastPolledAt = now

      if (!prev) {
        // Baseline: don't announce what was already going on, but remember
        // running matches so we can still report their results.
        if (next.kind === 'in_game') this.#registerMatch(id, next.opponentId, next.startTime, now, true)
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
            started.add(m)
            this.heat(t.opponentId, now)
            break
          }
          case 'match_end': {
            p.hotUntil = now + this.#cfg.hotCooldownMs
            p.lastActiveAt = now
            const m = this.#findMatch(id, t.opponentId, t.startTime)
            if (m) this.#endMatch(m, now)
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

  #findMatch(a: string, b: string, startTime: number): TrackedMatch | undefined {
    for (const m of this.activeMatches) {
      if (
        m.players.includes(a) &&
        m.players.includes(b) &&
        Math.abs(m.startTime - startTime) < SAME_MATCH_TOLERANCE_MS
      ) {
        return m
      }
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

  #endMatch(m: TrackedMatch, now: number) {
    if (!this.activeMatches.delete(m)) return
    m.endedAt = now
    this.emit('match_end', m)
    this.#lookupResult(m, 0, false)
  }

  #lookupResult(m: TrackedMatch, attempt: number, reachedBotlatro: boolean) {
    const delay = RESULT_LOOKUP_DELAYS_MS[attempt]
    if (delay === undefined) {
      this.emit('match_result', m, { status: reachedBotlatro ? 'not_found' : 'unavailable' })
      return
    }
    this.#later(delay, async () => {
      try {
        const result = findResult(await this.#api.fetchRecentMatches(m.players[0]), m)
        reachedBotlatro = true
        if (result) {
          this.emit('match_result', m, { status: 'found', result })
          return
        }
      } catch (err) {
        console.error('[tracker] result lookup failed:', describe(err))
      }
      this.#lookupResult(m, attempt + 1, reachedBotlatro)
    })
  }
}

/**
 * Finds the completed history entry for a tracked match, from the perspective
 * of `m.players[0]`. Botlatro match ids are sequential, so among completed
 * matches against this opponent that weren't created before the match
 * started, the newest is the one that just ended.
 */
export function findResult(history: PlayerMatch[], m: TrackedMatch): PlayerMatch | null {
  const opponent = m.players[1]
  const candidates = history.filter(
    (h) =>
      h.winning_team !== null &&
      h.opponents.some((o) => o.user_id === opponent) &&
      Date.parse(h.created_at) >= m.startTime - 60_000
  )
  candidates.sort((a, b) => b.match_id - a.match_id)
  return candidates[0] ?? null
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.cause instanceof Error ? `${err.message} (${err.cause.message})` : err.message
  return String(err)
}
