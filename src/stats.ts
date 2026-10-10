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
    opponent_name: g.opponentName,
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

/** Record with one deck or stake. */
export type GroupStats = { name: string; games: number; wins: number; winrate: number }

export type PlayerStats = {
  games: number
  wins: number
  losses: number
  winrate: number
  seasons: number
  avgDurationMs: number | null
  durationSamples: number
  /** Best → worst (small samples weighted toward their average, see rankGroups); Cocktail Deck left out. */
  decks: GroupStats[]
  /** Best → worst, like decks; Red, Orange and Blue Stake left out. */
  stakes: GroupStats[]
  /** The viewer's own record against this player, from the viewer's side. */
  vsViewer?: { wins: number; losses: number; winrate: number }
  /** The opponent they lost the most MMR to, and the one they won the most from (see pickNemesisAndVictim). */
  nemesis?: Rival
  victim?: Rival
  /** MMR gained/lost per game by hour of the day (see mmrByHour). */
  byHour: MmrByHour
  timeZone: string
}

const rate = (wins: number, games: number) => (games ? wins / games : 0)
/** Stakes left out of the stake stats. */
const IGNORED_STAKES = /^(red|orange|blue)( stake)?$/i
/** Virtual games at the player's average added to each deck/stake when ranking them. */
const GROUP_PRIOR_GAMES = 10

/**
 * Win rate per deck or stake, best → worst. Ranked by win rate shrunk towards
 * the player's overall one (as for time of day), so a deck won once doesn't
 * top one with 75% over a hundred games; the real win rate is what's shown.
 */
export function rankGroups(decided: GameRow[], key: (g: GameRow) => string | null, overall: number): GroupStats[] {
  const groups = new Map<string, { games: number; wins: number }>()
  for (const g of decided) {
    const name = key(g)
    if (!name) continue
    const d = groups.get(name) ?? { games: 0, wins: 0 }
    d.games++
    if (g.result === 'win') d.wins++
    groups.set(name, d)
  }
  const ranking = (d: { games: number; wins: number }) => (d.wins + GROUP_PRIOR_GAMES * overall) / (d.games + GROUP_PRIOR_GAMES)
  return [...groups]
    .map(([name, d]) => ({ name, ...d, winrate: rate(d.wins, d.games) }))
    .sort((a, b) => ranking(b) - ranking(a) || b.games - a.games)
}

export function computeStats(games: GameRow[], durationsMs: number[], viewerId?: string, timeZone = 'UTC'): PlayerStats {
  const decided = games.filter((g) => g.result !== 'tie')
  const wins = decided.filter((g) => g.result === 'win').length
  const overall = rate(wins, decided.length)
  const decks = rankGroups(decided, (g) => (g.deck && !/cocktail/i.test(g.deck) ? g.deck : null), overall)
  const stakes = rankGroups(decided, (g) => (g.stake && !IGNORED_STAKES.test(g.stake) ? g.stake : null), overall)

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
    stakes,
    vsViewer,
    ...pickNemesisAndVictim(computeRivals(games)),
    byHour: mmrByHour(games, timeZone),
    timeZone,
  }
}

// ------------------------------------------------------------------- rivals

/** Record against one opponent, from the player's side. */
export type Rival = {
  id: string
  /** Their name in the most recent game against them (from the site's history). */
  name: string | null
  games: number
  wins: number
  losses: number
  /** MMR won (+) or lost (−) against them in total. */
  netMmr: number
}

/** Record against every opponent (ties left out). */
export function computeRivals(games: GameRow[]): Rival[] {
  const byOpponent = new Map<string, Rival & { lastPlayed: number }>()
  for (const g of games) {
    if (g.result === 'tie') continue
    const r = byOpponent.get(g.opponent_id) ?? {
      id: g.opponent_id,
      name: null,
      games: 0,
      wins: 0,
      losses: 0,
      netMmr: 0,
      lastPlayed: 0,
    }
    r.games++
    if (g.result === 'win') r.wins++
    else r.losses++
    r.netMmr += g.mmr_change ?? 0
    if (g.opponent_name && g.played_at >= r.lastPlayed) {
      r.name = g.opponent_name
      r.lastPlayed = g.played_at
    }
    byOpponent.set(g.opponent_id, r)
  }
  return [...byOpponent.values()].map(({ lastPlayed: _, ...r }) => r)
}

/** Opponents need this many games to count as a nemesis / victim (one unlucky game isn't a rivalry). */
const MIN_RIVAL_GAMES = 3

/** Nemesis: lost the most MMR to; favourite victim: won the most MMR from. */
export function pickNemesisAndVictim(rivals: Rival[], minGames = MIN_RIVAL_GAMES): { nemesis?: Rival; victim?: Rival } {
  const eligible = rivals.filter((r) => r.games >= minGames)
  const nemesis = eligible.filter((r) => r.netMmr < 0).sort((a, b) => a.netMmr - b.netMmr || b.games - a.games)[0]
  const victim = eligible.filter((r) => r.netMmr > 0).sort((a, b) => b.netMmr - a.netMmr || b.games - a.games)[0]
  return { nemesis, victim }
}

/** "2W – 9L · **−84.3** MMR". */
export function rivalRecord(r: Rival): string {
  return `${r.wins}W – ${r.losses}L · **${signed(r.netMmr)}** MMR`
}

/** /rivals: nemeses, favourite victims and most played opponents. */
export function rivalsText(rivals: Rival[], label: (r: Rival) => string, top = 5): string {
  const eligible = rivals.filter((r) => r.games >= MIN_RIVAL_GAMES)
  const section = (title: string, list: Rival[]) =>
    list.length ? ['', title, ...list.map((r, i) => `${i + 1}. ${label(r)} · ${r.games} games · ${rivalRecord(r)}`)] : []
  const lines = [
    ...section(
      '😈 **Nemeses** (most MMR lost to)',
      eligible.filter((r) => r.netMmr < 0).sort((a, b) => a.netMmr - b.netMmr).slice(0, top)
    ),
    ...section(
      '🎯 **Favourite victims** (most MMR won from)',
      eligible.filter((r) => r.netMmr > 0).sort((a, b) => b.netMmr - a.netMmr).slice(0, top)
    ),
    ...section('🔁 **Most played**', [...rivals].sort((a, b) => b.games - a.games || b.netMmr - a.netMmr).slice(0, top)),
  ]
  return lines.length ? lines.slice(1).join('\n') : '-# No ranked games found.'
}

// -------------------------------------------------------------- time of day

/** Hour of the day (0–23) of a timestamp in a time zone. */
export function hourOfDay(ms: number, timeZone: string): number {
  return Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone }).format(ms)) % 24
}

export type HourStat = {
  hour: number
  /** Games (with a known MMR change) started in this hour. */
  games: number
  /** Games in the pooled window around it (this hour ± `window`). */
  pooled: number
  /** Smoothed average MMR change per game, or null when there's too little data to say. */
  mmr: number | null
}

export type MmrByHour = {
  /** Average MMR change per game over all their games. */
  overall: number
  games: number
  hours: HourStat[]
}

/**
 * Average MMR gained or lost per game by hour of the day. MMR change already
 * weighs opponent strength (beating a much higher player gains more, beating
 * a much lower one barely counts), unlike a plain win rate. Made robust
 * against small samples:
 *  - each hour pools the games of its neighbours too (± `window` hours,
 *    wrapping around midnight), since hour boundaries are arbitrary;
 *  - the pooled average is shrunk towards the player's overall average by
 *    `prior` virtual games ((sum + prior·overall) / (games + prior)), so a
 *    slot with a handful of games barely moves while one with dozens shows a
 *    real tendency;
 *  - hours with fewer than `minGames` pooled games get no number at all.
 * Games only known from the opponent's side (no MMR change yet) are skipped.
 */
export function mmrByHour(
  games: GameRow[],
  timeZone: string,
  opts: { window?: number; prior?: number; minGames?: number } = {}
): MmrByHour {
  const { window = 1, prior = 10, minGames = 5 } = opts
  const rated = games.filter((g) => g.mmr_change !== null)
  const total = rated.reduce((sum, g) => sum + g.mmr_change!, 0)
  const overall = rated.length ? total / rated.length : 0
  const perHour = Array.from({ length: 24 }, () => ({ games: 0, sum: 0 }))
  for (const g of rated) {
    const h = perHour[hourOfDay(g.played_at, timeZone)]!
    h.games++
    h.sum += g.mmr_change!
  }
  const hours = perHour.map((h, hour) => {
    let pooled = 0
    let sum = 0
    for (let d = -window; d <= window; d++) {
      const n = perHour[(hour + d + 24) % 24]!
      pooled += n.games
      sum += n.sum
    }
    return { hour, games: h.games, pooled, mmr: pooled >= minGames ? (sum + prior * overall) / (pooled + prior) : null }
  })
  return { overall, games: rated.length, hours }
}

/** "+3.1" / "−2.4". */
export function signed(v: number): string {
  return `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(1)}`
}

/** "Best around 21h (+3.1 MMR/game) · worst around 4h (−2.4) · now (17h): +0.8 MMR/game over 132 games". */
export function mmrByHourSummary(t: MmrByHour, nowHour: number): string {
  const known = t.hours.filter((h) => h.mmr !== null)
  if (!known.length) return 'Not enough games yet to tell.'
  const best = known.reduce((a, b) => (b.mmr! > a.mmr! ? b : a))
  const worst = known.reduce((a, b) => (b.mmr! < a.mmr! ? b : a))
  const now = t.hours[nowHour]!
  const nowText =
    now.mmr === null ? `now (${nowHour}h): too few games` : `now (${nowHour}h): **${signed(now.mmr)}** MMR/game over ${now.pooled} games`
  return `Best around ${best.hour}h (**${signed(best.mmr!)}** MMR/game) · worst around ${worst.hour}h (**${signed(worst.mmr!)}**) · ${nowText}`
}

// ---------------------------------------------------------------- rendering

const pct = (r: number) => `${(r * 100).toFixed(1)}%`

/** ▰▰▰▰▰▰▰▱▱▱ for a 0–1 ratio. */
export function bar(ratio: number, width = 10): string {
  const filled = Math.round(Math.max(0, Math.min(1, ratio)) * width)
  return '▰'.repeat(filled) + '▱'.repeat(width - filled)
}

/** "**Season standing:** #12 of 5,301 · **top 0.2%** · 1290 MMR". */
export function standingLine(s: { rank: number; total: number; mmr?: number }): string {
  const top = (s.rank / Math.max(s.total, s.rank)) * 100
  const topText = top < 10 ? top.toFixed(1) : String(Math.round(top))
  return (
    `**Season standing:** #${s.rank.toLocaleString('en-US')} of ${s.total.toLocaleString('en-US')} · **top ${topText}%**` +
    (s.mmr !== undefined ? ` · ${Math.round(s.mmr)} MMR` : '')
  )
}

/**
 * Embed text for /stats. `viewerRanked`: the viewer is a ranked player
 * themselves (so "no games against them yet" is worth saying).
 */
export function statsText(
  s: PlayerStats,
  opts: {
    deckEmoji: (deck: string) => string
    stakeEmoji: (stake: string) => string
    viewerRanked: boolean
    isSelf: boolean
    /** How a rival is shown (linked name). */
    rivalLabel?: (r: Rival) => string
    /** Current season standing, if they're ranked this season. */
    standing?: { rank: number; total: number; mmr?: number }
    now?: number
  }
): { description: string; footer: string } {
  if (s.games === 0) return { description: '-# No ranked games found.', footer: 'Ranked · all seasons · balatromp.com' }
  const lines = [
    ...(opts.standing ? [standingLine(opts.standing)] : []),
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
  const rivalLabel = opts.rivalLabel ?? ((r: Rival) => `**${r.name ?? 'unknown player'}**`)
  if (s.nemesis) lines.push(`**Nemesis:** ${rivalLabel(s.nemesis)} · ${rivalRecord(s.nemesis)}`)
  if (s.victim) lines.push(`**Favourite victim:** ${rivalLabel(s.victim)} · ${rivalRecord(s.victim)}`)
  const nowHour = hourOfDay(opts.now ?? Date.now(), s.timeZone)
  if (s.byHour.games) {
    // The chart itself is an image under the embed (see charts.ts).
    lines.push('', `**MMR per game by time of day** (${s.timeZone}, smoothed, chart below)`, mmrByHourSummary(s.byHour, nowHour))
  }
  const section = (title: string, groups: GroupStats[], emoji: (name: string) => string, suffix: RegExp) => {
    if (!groups.length) return
    lines.push('', `**${title}** (best → worst; few games count for less)`)
    for (const g of groups) {
      const games = `${g.games} game${g.games === 1 ? '' : 's'}`
      lines.push(`${emoji(g.name)} \`${bar(g.winrate)}\` **${pct(g.winrate)}** ${g.name.replace(suffix, '')} · ${games}`)
    }
  }
  section('Decks', s.decks, opts.deckEmoji, / Deck$/)
  section('Stakes', s.stakes, opts.stakeEmoji, / Stake$/)
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
    // Also refetch once if their games were stored before opponent names were kept.
    const namesMissing = lastFull !== undefined && !this.#store.hasOpponentNames(playerId)
    if (!lastFull || namesMissing || Date.now() - lastFull.synced_at > FULL_REFETCH_AFTER_MS) {
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

  /** Record against every opponent (call sync first). */
  rivals(playerId: string): Rival[] {
    return computeRivals(this.#store.gamesOf(playerId))
  }

  /** Stats for a player (call sync first), with the viewer's record against them. */
  stats(playerId: string, viewerId: string | undefined, timeZone: string): PlayerStats {
    return computeStats(this.#store.gamesOf(playerId), this.#store.gameDurations(playerId), viewerId, timeZone)
  }
}
