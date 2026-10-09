import type { Api, SiteGame } from './api.ts'
import type { TrackedMatch } from './tracker.ts'

/** One game from a player's history on balatromp.com. */
export type MatchRecord = {
  matchId: number
  createdAt: number
  /** The player whose history this came from; `won`/`mmrChange` are from their side. */
  playerId: string
  opponentId: string
  won: boolean
  mmrChange: number
  deck: string | null
  stake: string | null
  /** 'ranked', 'casual', … */
  gameType: string
  /** 'season7', … */
  season: string | null
}

export function fromSite(g: SiteGame): MatchRecord {
  return {
    matchId: g.gameId,
    createdAt: Date.parse(g.gameTime),
    playerId: g.playerId,
    opponentId: g.opponentId,
    won: g.result === 'win',
    mmrChange: g.mmrChange,
    deck: g.deck,
    stake: g.stake,
    gameType: g.gameType,
    season: g.season,
  }
}

/** Slack for clock differences between the site and us. */
const CLOCK_SLACK_MS = 60_000

/**
 * Finds the history entry for a tracked match, from the perspective of
 * `m.players[0]`. It must be against the right opponent and created within the
 * match's lifetime: anything created after we saw the match end is a later
 * game (e.g. a rematch). Among the rest, the newest (highest id) wins.
 */
export function findResult(history: MatchRecord[], m: TrackedMatch): MatchRecord | null {
  const opponent = m.players[1]
  const endedAt = m.endedAt ?? Number.POSITIVE_INFINITY
  const candidates = history.filter(
    (h) =>
      h.opponentId === opponent &&
      h.createdAt >= m.startTime - CLOCK_SLACK_MS &&
      h.createdAt <= endedAt + CLOCK_SLACK_MS
  )
  candidates.sort((a, b) => b.matchId - a.matchId)
  return candidates[0] ?? null
}

const SEASON_TTL_MS = 6 * 3_600_000
/** Newest games to fetch; the site asks its backend for 5× this many. */
const PAGE_SIZE = 3

/**
 * Match history via balatromp.com's public `history.user_games_page`, which
 * is scoped to a season, so the active season key is looked up (and cached)
 * from `seasons.list`.
 */
export class ResultSource {
  readonly #api: Api
  #seasons: { list: Seasons; at: number } | undefined

  constructor(api: Api) {
    this.#api = api
  }

  async history(userId: string): Promise<MatchRecord[]> {
    const { active } = await this.seasons()
    const { data } = await this.#api.fetchMatchHistory(userId, active, { pageSize: PAGE_SIZE })
    return data.map(fromSite)
  }

  /** All seasons (oldest first) and the active one's key; cached. */
  async seasons(): Promise<Seasons> {
    if (this.#seasons && Date.now() - this.#seasons.at < SEASON_TTL_MS) return this.#seasons.list
    const seasons = [...(await this.#api.fetchSeasons())].sort((a, b) => Date.parse(a.startDate) - Date.parse(b.startDate))
    const active = seasons.find((s) => s.isActive) ?? seasons.at(-1)
    if (!active) throw new Error('No seasons listed on the site')
    const list: Seasons = {
      all: seasons.map((s) => ({ key: `season${s.id}`, endsAt: s.endDate ? Date.parse(s.endDate) : null })),
      active: `season${active.id}`,
    }
    this.#seasons = { list, at: Date.now() }
    return list
  }
}

export type Seasons = { all: Array<{ key: string; endsAt: number | null }>; active: string }
