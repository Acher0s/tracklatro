import type { Api } from './api.ts'
import type { Tracker } from './tracker.ts'

export type PlayerInfo = { name: string; mmr: number | null; rank: number | null }

/** Ranked data moves; names barely do. */
const RANKED_TTL_MS = 30 * 60_000
const UNRANKED_TTL_MS = 6 * 3_600_000

/**
 * Names / MMR / rank for players outside the tracked leaderboard range
 * (opponents of top players, subscribers, followed players), so every player
 * shows up by name and is visible to forecasts.
 *
 * Ranked players come from the site's cached season leaderboard
 * (`leaderboard.get_user_rank`, all misses in one batched request). Everyone
 * else falls back to Discord, which costs the site nothing.
 */
export class Directory {
  readonly #api: Api
  readonly #tracker: Tracker
  readonly #queueId: string
  readonly #cache = new Map<string, { info: PlayerInfo | null; at: number }>()
  readonly #inflight = new Map<string, Promise<void>>()
  /** Set by the bot once the Discord client exists. */
  discordName: ((id: string) => Promise<string | undefined>) | undefined

  constructor(opts: { api: Api; tracker: Tracker; queueId: string }) {
    this.#api = opts.api
    this.#tracker = opts.tracker
    this.#queueId = opts.queueId
    // Fill in newly seen players (e.g. opponents found during a poll) in the background.
    this.#tracker.on('round', () => {
      const unnamed = [...this.#tracker.players.values()].filter((p) => p.name === undefined).map((p) => p.id)
      if (unnamed.length) void this.ensure(unnamed)
    })
  }

  /** Cached info, if any (null = looked up, unknown everywhere). */
  get(id: string): PlayerInfo | null | undefined {
    return this.#cache.get(id)?.info
  }

  /** Makes sure the given players have been looked up; copies results onto tracked players. */
  async ensure(ids: readonly string[]): Promise<void> {
    const now = Date.now()
    const missing: string[] = []
    const waiting: Promise<void>[] = []
    for (const id of new Set(ids)) {
      const p = this.#tracker.players.get(id)
      if (p?.rank !== undefined) continue // on the tracked leaderboard: already complete
      const cached = this.#cache.get(id)
      const ttl = cached?.info?.mmr != null ? RANKED_TTL_MS : UNRANKED_TTL_MS
      if (cached && now - cached.at < ttl) {
        this.#apply(id, cached.info)
        continue
      }
      const pending = this.#inflight.get(id)
      if (pending) waiting.push(pending)
      else missing.push(id)
    }

    if (missing.length) {
      const job = this.#lookup(missing).finally(() => {
        for (const id of missing) this.#inflight.delete(id)
      })
      for (const id of missing) this.#inflight.set(id, job)
      waiting.push(job)
    }
    await Promise.all(waiting)
  }

  async #lookup(ids: string[]) {
    const now = Date.now()
    let ranked = new Map<string, { name: string; mmr: number; rank: number } | null>()
    try {
      ranked = await this.#api.fetchUserRanks(this.#queueId, ids)
    } catch (err) {
      console.warn('[directory] rank lookup failed:', err instanceof Error ? err.message : err)
    }
    await Promise.all(
      ids.map(async (id) => {
        const entry = ranked.get(id)
        let info: PlayerInfo | null = entry ? { name: entry.name, mmr: entry.mmr, rank: entry.rank } : null
        if (!info && ranked.has(id)) {
          // Not on the ranked leaderboard this season: ask Discord for a name.
          const name = await this.discordName?.(id).catch(() => undefined)
          if (name) info = { name, mmr: null, rank: null }
        }
        // Don't cache network failures: leave them for the next attempt.
        if (ranked.has(id)) this.#cache.set(id, { info, at: now })
        this.#apply(id, info)
      })
    )
  }

  #apply(id: string, info: PlayerInfo | null) {
    const p = this.#tracker.players.get(id)
    if (!p || !info) return
    // Only called for players outside the tracked range, so this never
    // overwrites fresher leaderboard data.
    p.name = info.name
    if (info.mmr !== null) p.mmr = info.mmr
    p.globalRank = info.rank ?? undefined
  }
}
