/**
 * Thin client for the two upstreams we read from:
 *  - balatromp.com tRPC (public procedures): leaderboard + live player state
 *  - Botlatro REST: per-player match history (for game results)
 *
 * Everything here is read-only and designed to minimise request count:
 * player states are fetched with tRPC request batching, so N players cost
 * ceil(N / STATE_BATCH_SIZE) HTTP requests per poll instead of N.
 */

/** Mirrors `PlayerState` in www/src/server/api/routers/player-state.ts */
export type RemotePlayerState = {
  status: 'idle' | 'queuing' | 'in_game'
  queueStartTime?: number
  currentMatch?: {
    opponentId: string
    startTime: number
  }
}

/** Mirrors `LeaderboardEntry` in www/src/server/services/botlatro.service.ts */
export type LeaderboardEntry = {
  id: string
  name: string
  mmr: number
  wins: number
  losses: number
  streak: number
  rank: number
  winrate: number
}

/** Mirrors `PlayerMatch` in www/src/server/services/botlatro.service.ts */
export type PlayerMatch = {
  match_id: number
  player_name: string
  player_id: string
  queue_id: number
  mmr_after: number
  won: boolean
  elo_change: number
  team: number
  opponents: Array<{
    user_id: string
    name: string
    team: number
    elo_change: number
    mmr_after: number
  }>
  deck: string | null
  stake: string | null
  best_of_3: boolean
  best_of_5: boolean
  created_at: string
  winning_team: number | null
}

export class HttpError extends Error {
  readonly status: number
  readonly retryAfterMs: number | undefined
  constructor(status: number, message: string, retryAfterMs?: number) {
    super(message)
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

// ~78 chars of URL per player state call, so 100 players ≈ 7.9 KB: just
// under the common 8 KB request-line limit (e.g. nginx). If the server ever
// rejects that (414/431) the client permanently shrinks its batches.
export const MAX_BATCH_SIZE = 100
const MAX_URL_LENGTH = 8_100
const LEADERBOARD_PAGE_SIZE = 100 // server-side max
const REQUEST_TIMEOUT_MS = 15_000

type TrpcBatchItem<T> =
  | { result: { data: { json: T } } }
  | { error: { json?: { message?: string } } }

export class Api {
  readonly #siteUrl: string
  readonly #botlatroUrl: string
  readonly #userAgent: string
  #maxUrlLength = MAX_URL_LENGTH

  /** Total HTTP requests made since start, by upstream. Exposed for /about. */
  readonly requestCounts = { site: 0, botlatro: 0 }

  constructor(opts: { siteUrl: string; botlatroUrl: string; contact?: string }) {
    this.#siteUrl = opts.siteUrl
    this.#botlatroUrl = opts.botlatroUrl
    this.#userAgent = `tracklatro/0.1 (Discord queue tracker${opts.contact ? `; contact: ${opts.contact}` : ''})`
  }

  async #get<T>(url: string, upstream: 'site' | 'botlatro'): Promise<T> {
    this.requestCounts[upstream]++
    const res = await fetch(url, {
      headers: { 'User-Agent': this.#userAgent, Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!res.ok) {
      const retryAfter = Number(res.headers.get('retry-after'))
      throw new HttpError(
        res.status,
        `${res.status} ${res.statusText} from ${new URL(url).pathname}`,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined
      )
    }
    return (await res.json()) as T
  }

  #batchUrl(procedure: string, inputs: unknown[]): string {
    const input = Object.fromEntries(inputs.map((value, i) => [i, { json: value }]))
    const paths = Array(inputs.length).fill(procedure).join(',')
    return `${this.#siteUrl}/api/trpc/${paths}?batch=1&input=${encodeURIComponent(JSON.stringify(input))}`
  }

  /**
   * Calls one tRPC query procedure many times using batched GETs, packing as
   * many calls per request as fit in MAX_URL_LENGTH (and MAX_BATCH_SIZE).
   */
  async #trpcBatch<I, O>(procedure: string, inputs: I[]): Promise<Array<O | Error>> {
    const out: Array<O | Error> = []
    let start = 0
    while (start < inputs.length) {
      let end = Math.min(start + MAX_BATCH_SIZE, inputs.length)
      while (end - start > 1 && this.#batchUrl(procedure, inputs.slice(start, end)).length > this.#maxUrlLength) {
        end = start + Math.floor((end - start) / 2)
      }
      const url = this.#batchUrl(procedure, inputs.slice(start, end))
      let items: TrpcBatchItem<O>[]
      try {
        items = await this.#get<TrpcBatchItem<O>[]>(url, 'site')
      } catch (err) {
        if (err instanceof HttpError && (err.status === 414 || err.status === 431) && end - start > 1) {
          this.#maxUrlLength = Math.floor(url.length * 0.75)
          console.warn(`[api] URL too long (${url.length}); limiting batches to ${this.#maxUrlLength} chars`)
          continue
        }
        throw err
      }
      for (const item of items) {
        out.push(
          'result' in item
            ? item.result.data.json
            : new Error(item.error.json?.message ?? `tRPC error in ${procedure}`)
        )
      }
      start = end
    }
    return out
  }

  /** Top `count` players by MMR; `count = 0` fetches the whole leaderboard. */
  async fetchLeaderboard(queueId: string, count: number): Promise<LeaderboardEntry[]> {
    const page = (n: number) => ({
      channel_id: queueId,
      page: n,
      pageSize: LEADERBOARD_PAGE_SIZE,
      sortBy: 'mmr',
      sortOrder: 'desc',
    })
    type PageResult = { data: LeaderboardEntry[]; totalPages: number }

    const [first] = await this.#trpcBatch<ReturnType<typeof page>, PageResult>(
      'leaderboard.get_leaderboard',
      [page(1)]
    )
    if (!first || first instanceof Error) throw first ?? new Error('Empty leaderboard response')

    const wantedPages =
      count === 0 ? first.totalPages : Math.min(first.totalPages, Math.ceil(count / LEADERBOARD_PAGE_SIZE))
    const rest = await this.#trpcBatch<ReturnType<typeof page>, PageResult>(
      'leaderboard.get_leaderboard',
      Array.from({ length: Math.max(0, wantedPages - 1) }, (_, i) => page(i + 2))
    )

    const entries = [...first.data]
    for (const result of rest) {
      if (result instanceof Error) throw result
      entries.push(...result.data)
    }
    return count === 0 ? entries : entries.slice(0, count)
  }

  /** Returns a map of userId → state (null = idle / no state stored). */
  async fetchStates(userIds: string[]): Promise<Map<string, RemotePlayerState | null>> {
    const out = new Map<string, RemotePlayerState | null>()
    const results = await this.#trpcBatch<string, RemotePlayerState | null>('playerState.getState', userIds)
    results.forEach((state, i) => {
      // A per-item error just means "unknown this round"; leave it out so the
      // tracker keeps the previous state instead of inventing a transition.
      if (!(state instanceof Error)) out.set(userIds[i]!, state)
    })
    return out
  }

  /**
   * Name / MMR / rank of arbitrary players from the site's cached season
   * leaderboard (null = not ranked this season). Ids that errored are absent.
   */
  async fetchUserRanks(
    queueId: string,
    userIds: string[]
  ): Promise<Map<string, { name: string; mmr: number; rank: number } | null>> {
    const results = await this.#trpcBatch<{ channel_id: string; user_id: string }, { data: LeaderboardEntry } | null>(
      'leaderboard.get_user_rank',
      userIds.map((user_id) => ({ channel_id: queueId, user_id }))
    )
    const out = new Map<string, { name: string; mmr: number; rank: number } | null>()
    results.forEach((r, i) => {
      if (r instanceof Error) return
      out.set(userIds[i]!, r ? { name: r.data.name, mmr: r.data.mmr, rank: r.data.rank } : null)
    })
    return out
  }

  /** Total players currently queued, per queue, including ones we don't track. */
  async fetchQueueCounts(): Promise<Map<string, number>> {
    type Count = { queue_id: number; players_in_queue: number }
    const [result] = await this.#trpcBatch<null, Count[]>('playerState.getActiveMatches', [null])
    if (!result || result instanceof Error) throw result ?? new Error('Empty active-matches response')
    return new Map(result.map((q) => [String(q.queue_id), q.players_in_queue]))
  }

  async fetchRecentMatches(userId: string, limit = 5): Promise<PlayerMatch[]> {
    const url = `${this.#botlatroUrl}/api/players/${encodeURIComponent(userId)}/matches?limit=${limit}`
    const res = await this.#get<{ matches: PlayerMatch[] }>(url, 'botlatro')
    return res.matches
  }
}
