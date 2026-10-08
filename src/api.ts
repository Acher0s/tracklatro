/**
 * Thin client for balatromp.com's public tRPC procedures: leaderboard, live
 * player state, match history, seasons and queue counts. Nothing else is
 * contacted.
 *
 * Everything here is read-only and designed to minimise request count: calls
 * are sent with tRPC request batching, so e.g. N player states cost
 * ceil(N / MAX_BATCH_SIZE) HTTP requests per poll instead of N.
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

/** Mirrors the `seasons` table in www/src/server/db/schema.ts (dates arrive as ISO strings). */
export type SiteSeason = { id: number; name: string; startDate: string; endDate: string | null; isActive: boolean }

/** Mirrors `SelectGames` as returned by www `history.user_games_page` (dates as ISO strings). */
export type SiteGame = {
  playerId: string
  gameId: number
  gameTime: string
  opponentId: string
  opponentName: string
  mmrChange: number
  result: 'win' | 'loss' | 'tie'
  deck: string | null
  stake: string | null
}

export type QueueCounts = { queued: number; running: number }

/** A player's standing on the season leaderboard. */
export type RankInfo = { name: string; mmr: number; rank: number; streak: number }

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
  readonly #userAgent: string
  #maxUrlLength = MAX_URL_LENGTH

  /** Total HTTP requests made since start. Exposed for /about. */
  requestCount = 0

  constructor(opts: { siteUrl: string; contact?: string }) {
    this.#siteUrl = opts.siteUrl
    this.#userAgent = `tracklatro/0.1 (Discord queue tracker${opts.contact ? `; contact: ${opts.contact}` : ''})`
  }

  async #get<T>(url: string): Promise<T> {
    this.requestCount++
    const res = await fetch(url, {
      headers: { 'User-Agent': this.#userAgent, Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!res.ok) {
      const retryAfter = Number(res.headers.get('retry-after'))
      throw new HttpError(
        res.status,
        `${res.status} ${res.statusText} from ${new URL(url).pathname.slice(0, 80)}`,
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
        items = await this.#get<TrpcBatchItem<O>[]>(url)
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

  /** A single call of a procedure; throws on a tRPC error. */
  async #trpcOne<I, O>(procedure: string, input: I): Promise<O> {
    const [result] = await this.#trpcBatch<I, O>(procedure, [input])
    if (result === undefined) throw new Error(`Empty response from ${procedure}`)
    if (result instanceof Error) throw result
    return result
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

    const first = await this.#trpcOne<ReturnType<typeof page>, PageResult>('leaderboard.get_leaderboard', page(1))
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
  ): Promise<Map<string, RankInfo | null>> {
    const results = await this.#trpcBatch<{ channel_id: string; user_id: string }, { data: LeaderboardEntry } | null>(
      'leaderboard.get_user_rank',
      userIds.map((user_id) => ({ channel_id: queueId, user_id }))
    )
    const out = new Map<string, RankInfo | null>()
    results.forEach((r, i) => {
      if (r instanceof Error) return
      out.set(userIds[i]!, r ? { name: r.data.name, mmr: r.data.mmr, rank: r.data.rank, streak: r.data.streak } : null)
    })
    return out
  }

  /** Players queued and matches running per queue, including ones we don't track. */
  async fetchQueueCounts(): Promise<Map<string, QueueCounts>> {
    type Count = { queue_id: number; players_in_queue: number; active_matches: number }
    const result = await this.#trpcOne<null, Count[]>('playerState.getActiveMatches', null)
    return new Map(result.map((q) => [String(q.queue_id), { queued: q.players_in_queue, running: q.active_matches }]))
  }

  async fetchSeasons(): Promise<SiteSeason[]> {
    return this.#trpcOne<null, SiteSeason[]>('seasons.list', null)
  }

  /** A player's newest games in a season (`season7`, …), newest first. */
  async fetchMatchHistory(userId: string, season: string, pageSize: number): Promise<SiteGame[]> {
    const result = await this.#trpcOne<object, { data: SiteGame[] }>('history.user_games_page', {
      user_id: userId,
      season,
      page: 1,
      pageSize,
      sortBy: 'gameTime',
      sortOrder: 'desc',
    })
    return result.data
  }
}
