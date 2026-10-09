import type { Api, SiteGame } from './api.ts'
import type { GameRow, Store } from './db.ts'
import { formatDuration } from './matchmaking.ts'
import type { MatchRecord, ResultSource } from './results.ts'
import type { MatchOutcome, TrackedMatch, Tracker } from './tracker.ts'

// ---------------------------------------------------------------- game rows

/** Standard ranked only: older seasons spell it "Ranked"; legacy, smallworld etc. are other modes. */
export function isRanked(g: { gameType: string }): boolean {
  return g.gameType.toLowerCase() === 'ranked'
}

export function rowFromSite(g: SiteGame): GameRow {
  return {
    player_id: g.playerId,
    match_id: g.gameId,
    played_at: Date.parse(g.gameTime),
    opponent_id: g.opponentId,
    result: g.result,
    mmr_change: g.mmrChange,
    deck: g.deck,
    stake: g.stake,
    season: g.season ?? '',
    duration_ms: null,
  }
}

/** A result the bot saw live, as rows for both players (the opponent's side has no MMR change). */
export function rowsFromResult(r: MatchRecord, m: TrackedMatch): GameRow[] {
  const opponent = m.players[0] === r.playerId ? m.players[1] : m.players[0]
  // Only a match we saw end has a real length (not one we timed out on and only later found).
  const duration = m.endedAt !== undefined && (!m.timedOut || m.lateResult) ? m.endedAt - m.startTime : null
  const base = { match_id: r.matchId, played_at: r.createdAt, deck: r.deck, stake: r.stake, season: r.season ?? '', duration_ms: duration }
  return [
    { ...base, player_id: r.playerId, opponent_id: opponent, result: r.won ? 'win' : 'loss', mmr_change: r.mmrChange },
    { ...base, player_id: opponent, opponent_id: r.playerId, result: r.won ? 'loss' : 'win', mmr_change: null },
  ]
}

// -------------------------------------------------------------------- stats

export type DeckStats = { deck: string; games: number; wins: number; winrate: number }

export type PlayerStats = {
  games: number
  wins: number
  losses: number
  winrate: number
  seasons: number
  avgDurationMs: number | null
  durationSamples: number
  /** Best → worst (small samples weighted toward their average, see computeStats); Cocktail Deck left out. */
  decks: DeckStats[]
  /** The viewer's own record against this player, from the viewer's side. */
  vsViewer?: { wins: number; losses: number; winrate: number }
  /** Win rate by hour of the day (see timeOfDay). */
  byHour: TimeOfDay
  timeZone: string
}

const rate = (wins: number, games: number) => (games ? wins / games : 0)
/** Virtual games at the player's average added to each deck when ranking decks. */
const DECK_PRIOR_GAMES = 10

export function computeStats(games: GameRow[], durationsMs: number[], viewerId?: string, timeZone = 'UTC'): PlayerStats {
  const decided = games.filter((g) => g.result !== 'tie')
  const wins = decided.filter((g) => g.result === 'win').length

  const byDeck = new Map<string, { games: number; wins: number }>()
  for (const g of decided) {
    if (!g.deck || /cocktail/i.test(g.deck)) continue
    const d = byDeck.get(g.deck) ?? { games: 0, wins: 0 }
    d.games++
    if (g.result === 'win') d.wins++
    byDeck.set(g.deck, d)
  }
  // Ranked by win rate shrunk towards their overall one (as for time of day),
  // so a deck won once doesn't top one with 75% over a hundred games; the
  // real win rate is what's shown.
  const overall = rate(wins, decided.length)
  const ranking = (d: { games: number; wins: number }) => (d.wins + DECK_PRIOR_GAMES * overall) / (d.games + DECK_PRIOR_GAMES)
  const decks = [...byDeck]
    .map(([deck, d]) => ({ deck, ...d, winrate: rate(d.wins, d.games) }))
    .sort((a, b) => ranking(b) - ranking(a) || b.games - a.games)

  let vsViewer: PlayerStats['vsViewer']
  if (viewerId) {
    const head = decided.filter((g) => g.opponent_id === viewerId)
    if (head.length) {
      // Rows are from this player's side: their losses are the viewer's wins.
      const viewerWins = head.filter((g) => g.result === 'loss').length
      vsViewer = { wins: viewerWins, losses: head.length - viewerWins, winrate: rate(viewerWins, head.length) }
    }
  }

  return {
    games: decided.length,
    wins,
    losses: decided.length - wins,
    winrate: rate(wins, decided.length),
    seasons: new Set(games.map((g) => g.season).filter(Boolean)).size,
    avgDurationMs: durationsMs.length ? durationsMs.reduce((a, b) => a + b, 0) / durationsMs.length : null,
    durationSamples: durationsMs.length,
    decks,
    vsViewer,
    byHour: timeOfDay(games, timeZone),
    timeZone,
  }
}

// -------------------------------------------------------------- time of day

/** Hour of the day (0–23) of a timestamp in a time zone. */
export function hourOfDay(ms: number, timeZone: string): number {
  return Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone }).format(ms)) % 24
}

export type HourStat = {
  hour: number
  /** Games started in this hour. */
  games: number
  /** Games in the pooled window around it (this hour ± `window`). */
  pooled: number
  /** Smoothed win rate, or null when there's too little data to say. */
  winrate: number | null
}

export type TimeOfDay = { overall: number; hours: HourStat[] }

/**
 * Win rate by hour of the day, made robust against small samples:
 *  - each hour pools the games of its neighbours too (± `window` hours,
 *    wrapping around midnight), since hour boundaries are arbitrary;
 *  - the pooled rate is shrunk towards the player's overall win rate by
 *    `prior` virtual games ((wins + prior·overall) / (games + prior)), so a
 *    slot with a handful of games barely moves from their average while one
 *    with dozens shows a real tendency;
 *  - hours with fewer than `minGames` pooled games get no number at all.
 */
export function timeOfDay(
  games: GameRow[],
  timeZone: string,
  opts: { window?: number; prior?: number; minGames?: number } = {}
): TimeOfDay {
  const { window = 1, prior = 10, minGames = 5 } = opts
  const decided = games.filter((g) => g.result !== 'tie')
  const overall = rate(decided.filter((g) => g.result === 'win').length, decided.length)
  const perHour = Array.from({ length: 24 }, () => ({ games: 0, wins: 0 }))
  for (const g of decided) {
    const h = perHour[hourOfDay(g.played_at, timeZone)]!
    h.games++
    if (g.result === 'win') h.wins++
  }
  const hours = perHour.map((h, hour) => {
    let pooled = 0
    let wins = 0
    for (let d = -window; d <= window; d++) {
      const n = perHour[(hour + d + 24) % 24]!
      pooled += n.games
      wins += n.wins
    }
    return {
      hour,
      games: h.games,
      pooled,
      winrate: pooled >= minGames ? (wins + prior * overall) / (pooled + prior) : null,
    }
  })
  return { overall, hours }
}

const BLOCKS = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

/**
 * A 24-column bar chart (one column per hour) for a code block, scaled
 * between the lowest and highest smoothed win rate so differences are
 * visible; hours without enough data are a `·`; ▲ marks the current hour.
 */
export function hourChart(t: TimeOfDay, nowHour: number, rows = 4): string[] {
  const known = t.hours.filter((h) => h.winrate !== null).map((h) => h.winrate!)
  if (!known.length) return []
  let lo = Math.min(...known, t.overall)
  let hi = Math.max(...known, t.overall)
  if (hi - lo < 0.02) {
    // Practically flat: give it some headroom so it doesn't look dramatic.
    lo -= 0.02
    hi += 0.02
  }
  const levels = rows * 8
  const height = (wr: number) => Math.max(1, Math.round(((wr - lo) / (hi - lo)) * levels))
  const label = (r: number) => `${Math.round(r * 100)}%`.padStart(4)
  const lines: string[] = []
  for (let row = rows - 1; row >= 0; row--) {
    let line = ''
    for (const h of t.hours) {
      if (h.winrate === null) {
        line += row === 0 ? '·' : ' '
        continue
      }
      const fill = height(h.winrate) - row * 8
      line += fill >= 8 ? '█' : fill <= 0 ? ' ' : BLOCKS[fill]
    }
    const axis = row === rows - 1 ? `${label(hi)} ┤` : row === 0 ? `${label(lo)} ┤` : '     │'
    lines.push(`${axis}${line}`)
  }
  lines.push(`      ${'0     6     12    18   23'}`)
  lines.push(`      ${' '.repeat(nowHour)}▲ now`)
  return lines
}

/** "Best around 21h (+7%) · worst around 4h (−9%) · now (21h): +5% over 38 games". */
export function timeOfDaySummary(t: TimeOfDay, nowHour: number): string {
  const known = t.hours.filter((h) => h.winrate !== null)
  if (!known.length) return 'Not enough games yet to tell.'
  const diff = (wr: number) => {
    const d = Math.round((wr - t.overall) * 100)
    return d > 0 ? `+${d}%` : d < 0 ? `−${-d}%` : '±0%'
  }
  const best = known.reduce((a, b) => (b.winrate! > a.winrate! ? b : a))
  const worst = known.reduce((a, b) => (b.winrate! < a.winrate! ? b : a))
  const now = t.hours[nowHour]!
  const nowText =
    now.winrate === null
      ? `now (${nowHour}h): too few games`
      : `now (${nowHour}h): **${diff(now.winrate)}** over ${now.pooled} games`
  return `Best around ${best.hour}h (${diff(best.winrate!)}) · worst around ${worst.hour}h (${diff(worst.winrate!)}) · ${nowText}`
}

// ---------------------------------------------------------------- rendering

const pct = (r: number) => `${(r * 100).toFixed(1)}%`

/** ▰▰▰▰▰▰▰▱▱▱ for a 0–1 ratio. */
export function bar(ratio: number, width = 10): string {
  const filled = Math.round(Math.max(0, Math.min(1, ratio)) * width)
  return '▰'.repeat(filled) + '▱'.repeat(width - filled)
}

/**
 * Embed text for /stats. `viewerRanked`: the viewer is a ranked player
 * themselves (so "no games against them yet" is worth saying).
 */
export function statsText(
  s: PlayerStats,
  opts: { deckEmoji: (deck: string) => string; viewerRanked: boolean; isSelf: boolean; now?: number }
): { description: string; footer: string } {
  if (s.games === 0) return { description: '-# No ranked games found.', footer: 'Ranked · all seasons · balatromp.com' }
  const lines = [
    `**Record:** ${s.wins}W – ${s.losses}L · **${pct(s.winrate)}** winrate`,
    s.avgDurationMs !== null
      ? `**Avg game length:** ${formatDuration(s.avgDurationMs)} (from ${s.durationSamples} game${s.durationSamples === 1 ? '' : 's'} the bot watched)`
      : '**Avg game length:** — (no games watched by the bot yet)',
  ]
  if (!opts.isSelf) {
    if (s.vsViewer) {
      lines.push(`**You vs them:** ${s.vsViewer.wins}W – ${s.vsViewer.losses}L · **${pct(s.vsViewer.winrate)}**`)
    } else if (opts.viewerRanked) {
      lines.push('**You vs them:** no ranked games against each other yet')
    }
  }
  const nowHour = hourOfDay(opts.now ?? Date.now(), s.timeZone)
  const chart = hourChart(s.byHour, nowHour)
  if (chart.length) {
    lines.push('', `**Win rate by time of day** (${s.timeZone}, smoothed)`, '```', ...chart, '```', timeOfDaySummary(s.byHour, nowHour))
  }
  if (s.decks.length) {
    lines.push('', '**Decks** (best → worst; few games count for less)')
    for (const d of s.decks) {
      const name = d.deck.replace(/ Deck$/, '')
      lines.push(`${opts.deckEmoji(d.deck)} \`${bar(d.winrate)}\` **${pct(d.winrate)}** ${name} · ${d.games} game${d.games === 1 ? '' : 's'}`)
    }
  }
  return {
    description: lines.join('\n'),
    footer: `Ranked · ${s.games} games over ${s.seasons} season${s.seasons === 1 ? '' : 's'} · balatromp.com`,
  }
}

// ------------------------------------------------------------- sync plan

/** Slack when comparing our sync times with the site's game times. */
const SYNC_SLACK_MS = 10 * 60_000

/**
 * What to fetch for one player's season:
 *  - never synced → everything;
 *  - synced, but games may have happened since (current season, or a season
 *    that ended after our last sync, e.g. during downtime) → everything since
 *    the last sync. Games the bot recorded live don't count as synced: the bot
 *    may have been down before them;
 *  - synced after the season ended, or the current season very recently → skip.
 */
export function syncPlan(
  state: { synced_at: number } | undefined,
  isActive: boolean,
  endsAt: number | null,
  now: number
): { kind: 'all' } | { kind: 'since'; since: number } | { kind: 'skip' } {
  if (!state) return { kind: 'all' }
  const ended = !isActive && (endsAt === null || state.synced_at >= endsAt + SYNC_SLACK_MS)
  if (ended) return { kind: 'skip' }
  if (isActive && now - state.synced_at < TOP_UP_EVERY_MS) return { kind: 'skip' }
  return { kind: 'since', since: state.synced_at - SYNC_SLACK_MS }
}

// ------------------------------------------------------------------ service

/** Newest games per page (server max). */
const PAGE_SIZE = 100
/** The current season is topped up at most this often per player. */
const TOP_UP_EVERY_MS = 2 * 60_000
/** After this long without a full fetch (e.g. long downtime), fetch the complete history again: one request, and complete. */
const FULL_REFETCH_AFTER_MS = 14 * 24 * 3_600_000
/** Pause between history pages, to go easy on the site. */
const PAGE_GAP_MS = 300

export type SyncProgress = { season: string; seasonIndex: number; seasons: number; page: number; pages: number }

/**
 * Keeps a local copy of players' ranked games:
 *  - results the bot sees live are stored as they happen (with game length);
 *  - the first /stats for a player backfills every season from the site's
 *    history; past seasons are then kept as they are, the current one is
 *    topped up with its newest page.
 */
export class StatsService {
  readonly #api: Api
  readonly #store: Store
  readonly #results: ResultSource
  readonly #inflight = new Map<string, Promise<void>>()

  constructor(opts: { api: Api; store: Store; results: ResultSource; tracker: Tracker }) {
    this.#api = opts.api
    this.#store = opts.store
    this.#results = opts.results
    opts.tracker.on('match_result', (m, outcome) => this.#record(m, outcome))
  }

  #record(m: TrackedMatch, outcome: MatchOutcome) {
    if (outcome.status !== 'found' || !isRanked(outcome.result)) return
    try {
      this.#store.upsertGames(rowsFromResult(outcome.result, m))
    } catch (err) {
      console.warn('[stats] storing a result failed:', err instanceof Error ? err.message : err)
    }
  }

  /** Whether fetching this player's history will take a while (nothing fetched yet). */
  needsBackfill(playerId: string): boolean {
    return this.#store.historySync(playerId, '*') === undefined
  }

  /** Brings a player's games up to date with the site (one sync per player at a time). */
  sync(playerId: string, onProgress?: (p: SyncProgress) => void): Promise<void> {
    let job = this.#inflight.get(playerId)
    if (!job) {
      job = this.#sync(playerId, onProgress).finally(() => this.#inflight.delete(playerId))
      this.#inflight.set(playerId, job)
    }
    return job
  }

  async #sync(playerId: string, onProgress?: (p: SyncProgress) => void) {
    const { all, active } = await this.#results.seasons()
    const lastFull = this.#store.historySync(playerId, '*')
    if (!lastFull || Date.now() - lastFull.synced_at > FULL_REFETCH_AFTER_MS) {
      // First time (or after a long downtime): the complete history in one request.
      onProgress?.({ season: 'all', seasonIndex: 1, seasons: 1, page: 1, pages: 1 })
      const startedAt = Date.now()
      const games = await this.#api.fetchFullHistory(playerId)
      this.#store.upsertGames(games.filter(isRanked).map(rowFromSite))
      for (const { key } of all) this.#store.setHistorySync(playerId, key, startedAt)
      this.#store.setHistorySync(playerId, '*', startedAt)
      return
    }
    // Otherwise top up what may have happened since the last sync (newest
    // pages only; recent games are always within the paged procedure's reach).
    for (const [i, { key: season, endsAt }] of all.entries()) {
      const plan = syncPlan(this.#store.historySync(playerId, season), season === active, endsAt, Date.now())
      if (plan.kind === 'skip') continue
      const startedAt = Date.now()
      let page = 1
      let pages = 1
      do {
        onProgress?.({ season, seasonIndex: i + 1, seasons: all.length, page, pages })
        const res = await this.#api.fetchMatchHistory(playerId, season, { pageSize: PAGE_SIZE, page, gameType: 'ranked' })
        pages = Math.max(1, res.totalPages)
        this.#store.upsertGames(res.data.filter(isRanked).map(rowFromSite))
        // Newest first: once a page reaches back past the last sync, the gap is filled.
        const oldest = res.data.at(-1)
        if (res.data.length < PAGE_SIZE || (plan.kind === 'since' && oldest && Date.parse(oldest.gameTime) < plan.since)) break
        page++
        await new Promise((r) => setTimeout(r, PAGE_GAP_MS))
      } while (page <= pages)
      this.#store.setHistorySync(playerId, season, startedAt)
    }
  }

  /** Stats for a player (call sync first), with the viewer's record against them. */
  stats(playerId: string, viewerId: string | undefined, timeZone: string): PlayerStats {
    return computeStats(this.#store.gamesOf(playerId), this.#store.gameDurations(playerId), viewerId, timeZone)
  }
}
