import type { Api, RankInfo } from './api.ts'
import type { Tracker } from './tracker.ts'

export type PlayerInfo = { name: string; mmr: number | null; rank: number | null; streak: number | null }

export type SearchHit = { id: string; name: string; mmr: number }

/** The site's search returns at most this many players. */
const SEARCH_PAGE = 10
const SEARCH_TTL_MS = 10 * 60_000

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
  readonly #searches = new Map<string, { hits: SearchHit[]; at: number }>()
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

  /**
   * Ranked players matching a name, via the site's own search (top 10). For
   * autocomplete, so it's frugal: results are cached, and a longer query that
   * extends a cached one with a complete result list (< 10) is filtered locally.
   */
  async search(query: string): Promise<SearchHit[]> {
    const q = query.trim().toLowerCase()
    if (q.length < 2) return []
    const now = Date.now()
    const cached = this.#searches.get(q)
    if (cached && now - cached.at < SEARCH_TTL_MS) return cached.hits
    for (let len = q.length - 1; len >= 2; len--) {
      const prefix = this.#searches.get(q.slice(0, len))
      if (prefix && now - prefix.at < SEARCH_TTL_MS && prefix.hits.length < SEARCH_PAGE) {
        return prefix.hits.filter((h) => h.name.toLowerCase().includes(q) || h.id.startsWith(q))
      }
    }
    const hits = await this.#api.searchPlayers(q)
    this.#searches.set(q, { hits, at: now })
    if (this.#searches.size > 500) this.#searches.delete(this.#searches.keys().next().value!)
    return hits
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
    let ranked = new Map<string, RankInfo | null>()
    try {
      ranked = await this.#api.fetchUserRanks(this.#queueId, ids)
    } catch (err) {
      console.warn('[directory] rank lookup failed:', err instanceof Error ? err.message : err)
    }
    await Promise.all(
      ids.map(async (id) => {
        const entry = ranked.get(id)
        let info: PlayerInfo | null = entry ? { name: entry.name, mmr: entry.mmr, rank: entry.rank, streak: entry.streak } : null
        if (!info && ranked.has(id)) {
          // Not on the ranked leaderboard this season: ask Discord for a name.
          const name = await this.discordName?.(id).catch(() => undefined)
          if (name) info = { name, mmr: null, rank: null, streak: null }
        }
        // Don't cache network failures: leave them for the next attempt.
        if (ranked.has(id)) this.#cache.set(id, { info, at: now })
        this.#apply(id, info, true)
      })
    )
  }

  /** `fresh`: just looked up (vs. re-applied from cache, which mustn't undo streaks updated from results). */
  #apply(id: string, info: PlayerInfo | null, fresh = false) {
    const p = this.#tracker.players.get(id)
    if (!p || !info) return
    // Only called for players outside the tracked range, so this never
    // overwrites fresher leaderboard data.
    p.name = info.name
    if (info.mmr !== null) p.mmr = info.mmr
    p.globalRank = info.rank ?? undefined
    if (info.streak !== null && (fresh || p.streak === undefined)) p.streak = info.streak
  }
}
