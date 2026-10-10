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
  /** 'ranked', 'casual', … */
  gameType: string
  /** 'season7', … */
  season: string | null
}

export type QueueCounts = { queued: number; running: number }

/** Pick rate of a deck or stake ("yellow", "spectral+": lowercase, without "Deck"/"Stake"). */
export type Popularity = { name: string; games: number; pickRate: number }

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

  /** Total HTTP requests made since start (streams count once per connection). Exposed for /about. */
  requestCount = 0
  /** Players on the season leaderboard, as of the last leaderboard fetch (for "top X%"). */
  leaderboardTotal: number | undefined

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
    type PageResult = { data: LeaderboardEntry[]; totalPages: number; total: number }

    const first = await this.#trpcOne<ReturnType<typeof page>, PageResult>('leaderboard.get_leaderboard', page(1))
    this.leaderboardTotal = first.total
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
  // ------------------------------------------------------------ live streams

  /**
   * Opens a tRPC subscription as a server-sent event stream (what the site's
   * own pages use for live updates). Resolves when the stream ends; the
   * caller reconnects. See streams.ts.
   */
  async openStream(procedure: string, input: unknown, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    this.requestCount++
    const url = `${this.#siteUrl}/api/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`
    const res = await fetch(url, {
      headers: { 'User-Agent': this.#userAgent, Accept: 'text/event-stream' },
      signal,
    })
    if (!res.ok || !res.body) throw new HttpError(res.status, `${res.status} ${res.statusText} from stream ${procedure}`)
    return res.body
  }

  // ------------------------------------------------------------- site stats

  /** Players matching a name (or Discord id) on the ranked leaderboard: the site's own search box. */
  async searchPlayers(query: string): Promise<Array<{ id: string; name: string; mmr: number }>> {
    this.requestCount++
    const res = await fetch(`${this.#siteUrl}/api/search?query=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': this.#userAgent, Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!res.ok) throw new HttpError(res.status, `${res.status} ${res.statusText} from search`)
    const results = (await res.json()) as Array<{ type: string; discord_id?: string; username?: string; ranked_mmr?: number }>
    return results
      .filter((r) => r.type === 'player' && r.discord_id && r.username)
      .map((r) => ({ id: r.discord_id!, name: r.username!, mmr: r.ranked_mmr ?? 0 }))
  }

  /**
   * Games started per hour across the queue bot (all modes; almost all
   * ranked), whole history. Keys are "YYYY-MM-DD HH:00" in the site server's
   * time (UTC). Same input as the site's own activity chart, so it's one
   * shared cache entry the site keeps warm (a date-range input would make it
   * compute a fresh one).
   */
  async fetchGamesPerHour(): Promise<Array<{ timeUnit: string; count: number }>> {
    return this.#trpcOne<object, Array<{ timeUnit: string; count: number }>>('history.games_per_hour', { groupBy: 'hour' })
  }

  /** How often each deck / stake is picked in a season's queue (cached on the site). */
  async fetchPopularity(kind: 'deck' | 'stake', season: string, queueId: string): Promise<Popularity[]> {
    type Row = { deck?: string; stake?: string; games: number; pickRate: number }
    const rows = await this.#trpcOne<object, Row[]>(`stats.${kind}_popularity`, { mode: 'season', season, queueId })
    return rows.map((r) => ({ name: (kind === 'deck' ? r.deck : r.stake) ?? '?', games: r.games, pickRate: r.pickRate }))
  }

  /**
   * A player's entire history, every season and mode, in one request
   * (`history.user_games`: old seasons from the site's database, the rest
   * from the queue bot). The paged procedure below only looks at the newest
   * ~500 matches per page, so it can't reach older seasons.
   */
  async fetchFullHistory(userId: string): Promise<SiteGame[]> {
    return this.#trpcOne<object, SiteGame[]>('history.user_games', { user_id: userId })
  }

  async fetchMatchHistory(
    userId: string,
    season: string,
    opts: { pageSize: number; page?: number; gameType?: 'ranked' }
  ): Promise<{ data: SiteGame[]; totalPages: number }> {
    return this.#trpcOne<object, { data: SiteGame[]; totalPages: number }>('history.user_games_page', {
      user_id: userId,
      season,
      gameType: opts.gameType,
      page: opts.page ?? 1,
      pageSize: opts.pageSize, // server max 100
      sortBy: 'gameTime',
      sortOrder: 'desc',
    })
  }
}
