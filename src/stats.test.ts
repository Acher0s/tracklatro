import assert from 'node:assert/strict'
import { type TestContext, test } from 'node:test'
import type { Api, SiteGame } from './api.ts'
import { type GameRow, Store } from './db.ts'
import type { ResultSource, Seasons } from './results.ts'
import {
  bar,
  computeStats,
  hourOfDay,
  isRanked,
  mmrByHour,
  mmrByHourSummary,
  rowsFromResult,
  signed,
  StatsService,
  statsText,
  syncPlan,
} from './stats.ts'
import type { TrackedMatch, Tracker } from './tracker.ts'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

const row = (match_id: number, result: GameRow['result'], deck: string | null, opponent_id = 'x', played_at = match_id * MIN): GameRow => ({
  player_id: 'p',
  match_id,
  played_at,
  opponent_id,
  result,
  mmr_change: null,
  deck,
  stake: null,
  season: 'season7',
  duration_ms: null,
})

test('computeStats: record, decks best → worst without Cocktail, head-to-head', () => {
  const games = [
    row(1, 'win', 'Red Deck'),
    row(2, 'win', 'Red Deck'),
    row(3, 'loss', 'Red Deck'),
    row(4, 'win', 'Blue Deck'),
    row(5, 'loss', 'Plasma Deck'),
    row(6, 'win', 'Cocktail Deck'),
    row(7, 'tie', 'Blue Deck'),
    row(8, 'loss', 'Blue Deck', 'me'), // the viewer won this one
    row(9, 'win', 'Red Deck', 'me'),
  ]
  const s = computeStats(games, [20 * MIN, 30 * MIN], 'me')
  assert.deepEqual([s.games, s.wins, s.losses], [8, 5, 3]) // the tie doesn't count
  assert.deepEqual(
    s.decks.map((d) => `${d.name} ${d.wins}/${d.games}`),
    ['Red Deck 3/4', 'Blue Deck 1/2', 'Plasma Deck 0/1']
  )
  assert.equal(s.avgDurationMs, 25 * MIN)
  assert.deepEqual(s.vsViewer, { wins: 1, losses: 1, winrate: 0.5 })
})

test('a deck won once does not outrank a deck that wins a lot over many games', () => {
  const games: GameRow[] = [row(1, 'win', 'Lucky Deck')]
  for (let i = 0; i < 40; i++) games.push(row(100 + i, i % 4 ? 'win' : 'loss', 'Solid Deck')) // 75%
  for (let i = 0; i < 40; i++) games.push(row(200 + i, i % 2 ? 'win' : 'loss', 'Meh Deck')) // 50%
  const s = computeStats(games, [])
  assert.deepEqual(
    s.decks.map((d) => d.name),
    ['Solid Deck', 'Lucky Deck', 'Meh Deck']
  )
  assert.equal(s.decks[1]?.winrate, 1) // the real rate is still what's shown
})

test('stakes are ranked and shown alongside decks', () => {
  const games: GameRow[] = []
  for (let i = 0; i < 30; i++) games.push({ ...row(i, i % 3 ? 'win' : 'loss', 'Red Deck'), stake: 'White Stake' }) // 67%
  for (let i = 0; i < 30; i++) games.push({ ...row(100 + i, i % 3 ? 'loss' : 'win', 'Red Deck'), stake: 'Gold Stake' }) // 33%
  for (const stake of ['Red Stake', 'Orange Stake', 'Blue Stake']) games.push({ ...row(500, 'win', 'Red Deck'), stake })
  const s = computeStats(games, [])
  assert.deepEqual(
    s.stakes.map((g) => `${g.name} ${g.wins}/${g.games}`),
    ['White Stake 20/30', 'Gold Stake 10/30'] // Red, Orange and Blue left out
  )
  assert.equal(s.games, 63) // still in the overall record
  const text = statsText(s, { deckEmoji: () => '🃏', stakeEmoji: (n) => `<${n}>`, viewerRanked: false, isSelf: true }).description
  assert.ok(
    text.includes('**Stakes** (best → worst; few games count for less)\n<White Stake> `▰▰▰▰▰▰▰▱▱▱` **66.7%** White · 30 games'),
    text
  )
  assert.ok(text.indexOf('**Decks**') < text.indexOf('**Stakes**'))
})

test('only standard ranked counts (any capitalisation)', () => {
  assert.equal(isRanked({ gameType: 'ranked' }), true)
  assert.equal(isRanked({ gameType: 'Ranked' }), true)
  assert.equal(isRanked({ gameType: 'legacy' }), false)
  assert.equal(isRanked({ gameType: 'smallworld' }), false)
})

test('statsText: no subtext markers mid-line, head-to-head only when it makes sense', () => {
  const s = computeStats([row(1, 'win', 'Red Deck'), row(2, 'loss', 'Red Deck', 'me')], [], 'me')
  const t = statsText(s, { deckEmoji: () => '🃏', stakeEmoji: () => '🎲', viewerRanked: true, isSelf: false })
  assert.match(t.description, /\*\*Record:\*\* 1W – 1L · \*\*50\.0%\*\* winrate/)
  assert.match(t.description, /\*\*You vs them:\*\* 1W – 0L/)
  assert.match(t.description, /🃏 `▰▰▰▰▰▱▱▱▱▱` \*\*50\.0%\*\* Red · 2 games/)
  assert.ok(t.description.split('\n').every((l) => !l.includes('-#') || l.startsWith('-#')))
  assert.doesNotMatch(statsText(s, { deckEmoji: () => '', stakeEmoji: () => '', viewerRanked: true, isSelf: true }).description, /You vs them/)
  const none = computeStats([row(1, 'win', 'Red Deck')], [], 'me')
  assert.match(statsText(none, { deckEmoji: () => '', stakeEmoji: () => '', viewerRanked: true, isSelf: false }).description, /no ranked games against each other/)
  assert.doesNotMatch(statsText(none, { deckEmoji: () => '', stakeEmoji: () => '', viewerRanked: false, isSelf: false }).description, /You vs them/)
  assert.equal(bar(0.71), '▰▰▰▰▰▰▰▱▱▱')
})

test('rowsFromResult: both sides, with the watched game length', () => {
  const m = { players: ['a', 'b'], startTime: 1_000, endedAt: 1_000 + 25 * MIN } as TrackedMatch
  const rows = rowsFromResult(
    { matchId: 9, createdAt: 1_000, playerId: 'a', opponentId: 'b', won: true, mmrChange: 12, deck: 'Red Deck', stake: 'White Stake', gameType: 'ranked', season: 'season7' },
    m
  )
  assert.deepEqual(
    rows.map((r) => [r.player_id, r.opponent_id, r.result, r.mmr_change, r.duration_ms]),
    [
      ['a', 'b', 'win', 12, 25 * MIN],
      ['b', 'a', 'loss', null, 25 * MIN],
    ]
  )
})

// ------------------------------------------------------------ time of day

test('hourOfDay respects the time zone', () => {
  const t = Date.parse('2026-10-08T22:30:00Z')
  assert.equal(hourOfDay(t, 'UTC'), 22)
  assert.equal(hourOfDay(t, 'Europe/Brussels'), 0) // CEST, UTC+2
})

test('mmrByHour: one lucky game barely moves an hour; a real pattern shows', () => {
  const at = (h: number, i: number) => Date.UTC(2026, 9, 1 + i, h, 30)
  const rated = (id: number, mmr: number, played: number): GameRow => ({ ...row(id, mmr > 0 ? 'win' : 'loss', null, 'x', played), mmr_change: mmr })
  const games: GameRow[] = []
  // 100 games around the clock, breaking even (+10 / -10)...
  for (let i = 0; i < 100; i++) games.push(rated(i, i % 2 ? 10 : -10, at(i % 24, i)))
  // ...one huge win at 3h (beat someone far above them)...
  games.push(rated(1000, 30, at(3, 50)))
  // ...and a real evening slump: 30 extra games around 21h, mostly lost.
  for (let i = 0; i < 30; i++) games.push(rated(2000 + i, i < 6 ? 10 : -10, at(20 + (i % 3), 60 + i)))
  // Opponent-side rows without an MMR change are left out.
  games.push({ ...row(3000, 'loss', null, 'x', at(21, 99)), mmr_change: null })
  const t = mmrByHour(games, 'UTC')
  const mmr = (h: number) => t.hours[h]!.mmr!
  assert.equal(t.games, 131)
  assert.ok(Math.abs(mmr(3) - t.overall) < 2, `3h: ${mmr(3)} vs overall ${t.overall}`) // one game: noise
  assert.ok(mmr(21) < t.overall - 2.5, `21h: ${mmr(21)} vs overall ${t.overall}`) // pooled evidence: real
  assert.equal(mmrByHour([{ ...row(1, 'win', null, 'x', at(10, 0)), mmr_change: 12 }], 'UTC').hours[10]!.mmr, null)
  assert.match(
    mmrByHourSummary(t, 21),
    /^Best around \d+h \(\*\*\+\d+\.\d\*\* MMR\/game\) · worst around (20|21|22)h \(\*\*−\d+\.\d\*\*\) · now \(21h\): \*\*−\d+\.\d\*\* MMR\/game over \d+ games$/
  )
  assert.equal(signed(2.46), '+2.5')
  assert.equal(signed(-0.04), '−0.0')
})

// ------------------------------------------------------------------ syncing

test('syncPlan: backfill, top up since the last sync, catch up seasons that ended while down', () => {
  const now = 100 * DAY
  assert.deepEqual(syncPlan(undefined, true, null, now), { kind: 'all' })
  assert.deepEqual(syncPlan({ synced_at: now - MIN }, true, null, now), { kind: 'skip' }) // just synced
  // Current season, bot down for a week: everything since the last sync.
  assert.deepEqual(syncPlan({ synced_at: now - 7 * DAY }, true, null, now), { kind: 'since', since: now - 7 * DAY - 10 * MIN })
  // Past season synced after it ended: done for good.
  assert.deepEqual(syncPlan({ synced_at: now - DAY }, false, now - 2 * DAY, now), { kind: 'skip' })
  // Season ended while the bot was down: catch up its last days once.
  assert.deepEqual(syncPlan({ synced_at: now - 9 * DAY }, false, now - 5 * DAY, now), { kind: 'since', since: now - 9 * DAY - 10 * MIN })
})

const siteGame = (gameId: number, at: number, season: string, gameType = 'ranked'): SiteGame => ({
  playerId: 'p',
  gameId,
  gameTime: new Date(at).toISOString(),
  opponentId: 'x',
  opponentName: 'x',
  mmrChange: 10,
  result: 'win',
  deck: 'Red Deck',
  stake: 'White Stake',
  gameType,
  season,
})

/** Fake site: full history in one call, or per season newest first, paged. */
function fakeSite(games: SiteGame[]) {
  const calls: string[] = []
  const api = {
    fetchFullHistory: async () => {
      calls.push('full')
      return games
    },
    fetchMatchHistory: async (_userId: string, season: string, opts: { pageSize: number; page?: number }) => {
      const page = opts.page ?? 1
      calls.push(`${season} p${page}`)
      const all = games
        .filter((g) => g.season === season && isRanked(g))
        .sort((a, b) => Date.parse(b.gameTime) - Date.parse(a.gameTime))
      return {
        data: all.slice((page - 1) * opts.pageSize, page * opts.pageSize),
        totalPages: Math.max(1, Math.ceil(all.length / opts.pageSize)),
      }
    },
  } as unknown as Api
  return { api, calls }
}

const SEASONS: Seasons = {
  all: [
    { key: 'season6', endsAt: 30 * DAY },
    { key: 'season7', endsAt: null },
  ],
  active: 'season7',
}

function service(t: TestContext, api: Api, seasons = SEASONS) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 50 * DAY })
  const store = new Store(':memory:')
  t.after(() => store.close())
  const stats = new StatsService({
    api,
    store,
    results: { seasons: async () => seasons } as unknown as ResultSource,
    tracker: { on: () => {} } as unknown as Tracker,
  })
  return { store, stats }
}

/** Runs a sync while advancing fake time past the pauses between pages. */
async function sync(t: TestContext, stats: StatsService, id: string) {
  const done = stats.sync(id)
  for (let i = 0; i < 50; i++) {
    t.mock.timers.tick(1_000)
    await new Promise((r) => setImmediate(r))
  }
  await done
}

test('first /stats: the whole history in one request, ranked only; right after: nothing', async (t) => {
  const games = [
    ...Array.from({ length: 150 }, (_, i) => siteGame(i + 1, 10 * DAY + i * MIN, 'season6')),
    siteGame(1, 12 * DAY, 'season3', 'Ranked'), // old season, own numbering: same id, other season
    siteGame(900, 20 * DAY, 'season6', 'legacy'),
    siteGame(901, 21 * DAY, 'season6', 'smallworld'),
    ...Array.from({ length: 20 }, (_, i) => siteGame(1000 + i, 40 * DAY + i * MIN, 'season7')),
  ]
  const { api, calls } = fakeSite(games)
  const { store, stats } = service(t, api)
  assert.equal(stats.needsBackfill('p'), true)
  await sync(t, stats, 'p')
  assert.deepEqual(calls, ['full'])
  assert.equal(store.gamesOf('p').length, 171)
  assert.equal(stats.needsBackfill('p'), false)
  calls.length = 0
  await sync(t, stats, 'p')
  assert.deepEqual(calls, [])
})

test('after a week of downtime, the gap is filled even if newer games were recorded live', async (t) => {
  const games: SiteGame[] = [siteGame(1, 49 * DAY, 'season7')]
  const { api, calls } = fakeSite(games)
  const { store, stats } = service(t, api)
  await sync(t, stats, 'p') // full fetch at day 50

  // Bot down for a week: 120 games played meanwhile...
  for (let i = 0; i < 120; i++) games.push(siteGame(100 + i, 51 * DAY + i * MIN, 'season7'))
  t.mock.timers.setTime(57 * DAY)
  // ...then back up, and it records one game live before anyone runs /stats.
  games.push(siteGame(500, 57 * DAY, 'season7'))
  store.upsertGames([
    { player_id: 'p', match_id: 500, played_at: 57 * DAY, opponent_id: 'x', result: 'win', mmr_change: null, deck: null, stake: null, season: 'season7', duration_ms: 20 * MIN },
  ])

  calls.length = 0
  await sync(t, stats, 'p')
  assert.deepEqual(calls, ['season7 p1', 'season7 p2']) // paged back past the last sync
  assert.equal(store.gamesOf('p').length, 122)
  // The live game kept its watched length, and got its MMR change from the site.
  const live = store.gamesOf('p').find((g) => g.match_id === 500)
  assert.deepEqual([live?.duration_ms, live?.mmr_change], [20 * MIN, 10])
})

test('after a very long downtime, the whole history is fetched again (one request)', async (t) => {
  const { api, calls } = fakeSite([siteGame(1, 49 * DAY, 'season7')])
  const { stats } = service(t, api)
  await sync(t, stats, 'p')
  t.mock.timers.setTime(80 * DAY)
  calls.length = 0
  await sync(t, stats, 'p')
  assert.deepEqual(calls, ['full'])
})
