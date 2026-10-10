import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import type { Api, LeaderboardEntry } from './api.ts'
import { busiestHoursSvg, popularitySvg } from './charts.ts'
import type { Config } from './config.ts'
import { type GameRow, Store } from './db.ts'
import { Directory } from './directory.ts'
import { startsBetween } from './live.ts'
import { pickName } from './server.ts'
import { computeRivals, hourOfDay, pickNemesisAndVictim, rivalsText, standingLine } from './stats.ts'
import { SseParser } from './streams.ts'
import { Tracker } from './tracker.ts'
import { activitySummary, popularityFromCounts } from './widgets.ts'

// --------------------------------------------------------------- streams

test('SSE parser: events across chunks, ids, the "connected" event, keep-alives', () => {
  const p = new SseParser()
  assert.deepEqual(p.push('event: connected\ndata: {}\n\n'), [{ event: 'connected', id: undefined, data: '{}' }])
  assert.deepEqual(p.push('data: {"json":[1,'), [])
  assert.deepEqual(p.push('2]}\nid: initial\n\n: keep-alive\n\ndata: {"json":3}\r\nid: 17\r\n\r\n'), [
    { event: 'message', id: 'initial', data: '{"json":[1,2]}' },
    { event: 'message', id: '17', data: '{"json":3}' },
  ])
})

test('ranked matches started = rises in the running count', () => {
  assert.equal(startsBetween(undefined, 30), 0) // first count: just a baseline
  assert.equal(startsBetween(30, 31), 1)
  assert.equal(startsBetween(31, 29), 0) // matches ending
  assert.equal(startsBetween(29, 32), 3)
})

// --------------------------------------------------------------- trigger

test('a trigger polls everyone hot and warm, due or not', () => {
  const cfg = { topN: 100, hotIntervalMs: 10_000, warmIntervalMs: 30_000, hotCooldownMs: 600_000, warmWindowMs: 7_200_000 } as Config
  const tracker = new Tracker({ api: {} as Api, config: cfg, isWatched: () => false, hasConsumers: () => true })
  const entry = (id: string): LeaderboardEntry => ({ id, name: id, mmr: 1000, wins: 1, losses: 1, streak: 0, rank: 0, winrate: 0.5 })
  tracker.applyLeaderboard([entry('a'), entry('b')], 0)
  tracker.observe(new Map([['a', null], ['b', null]]), 1_000_000)
  assert.deepEqual(tracker.selectBatch(1_002_000), []) // nobody due 2 s later...
  assert.deepEqual(tracker.selectBatch(1_002_000, true).sort(), ['a', 'b']) // ...unless something happened
  tracker.stop()
})

// ---------------------------------------------------------------- rivals

const game = (match_id: number, opponent_id: string, result: GameRow['result'], mmr_change: number | null, opponent_name: string | null = opponent_id.toUpperCase()): GameRow => ({
  player_id: 'me',
  match_id,
  played_at: match_id * 1000,
  opponent_id,
  opponent_name,
  result,
  mmr_change,
  deck: null,
  stake: null,
  season: 'season7',
  duration_ms: null,
})

test('rivals: nemesis is who you lost the most MMR to, victim who you won the most from (3+ games)', () => {
  const games = [
    game(1, 'nem', 'loss', -15),
    game(2, 'nem', 'loss', -14),
    game(3, 'nem', 'win', 10),
    game(4, 'nem', 'loss', -12, 'Nem (renamed)'), // latest name wins
    game(5, 'vic', 'win', 12),
    game(6, 'vic', 'win', 11),
    game(7, 'vic', 'win', 13),
    game(8, 'oneoff', 'loss', -40), // big, but a single game isn't a rivalry
    game(9, 'tie', 'tie', 0),
    game(10, 'vic', 'win', null), // opponent-side copy without MMR: counts as a game
  ]
  const rivals = computeRivals(games)
  const { nemesis, victim } = pickNemesisAndVictim(rivals)
  assert.deepEqual(nemesis, { id: 'nem', name: 'Nem (renamed)', games: 4, wins: 1, losses: 3, netMmr: -31 })
  assert.deepEqual(victim, { id: 'vic', name: 'VIC', games: 4, wins: 4, losses: 0, netMmr: 36 })
  assert.equal(rivals.some((r) => r.id === 'tie'), false)

  const text = rivalsText(rivals, (r) => `**${r.name}**`)
  assert.match(text, /😈 \*\*Nemeses\*\* \(most MMR lost to\)\n1\. \*\*Nem \(renamed\)\*\* · 4 games · 1W – 3L · \*\*−31\.0\*\* MMR/)
  assert.match(text, /🎯 \*\*Favourite victims\*\* \(most MMR won from\)\n1\. \*\*VIC\*\* · 4 games · 4W – 0L · \*\*\+36\.0\*\* MMR/)
  assert.match(text, /🔁 \*\*Most played\*\*/)
  assert.equal(rivalsText([], (r) => r.id), '-# No ranked games found.')
})

test('season standing: top X%', () => {
  assert.equal(standingLine({ rank: 12, total: 5301, mmr: 1290.4 }), '**Season standing:** #12 of 5,301 · **top 0.2%** · 1290 MMR')
  assert.equal(standingLine({ rank: 2000, total: 5301 }), '**Season standing:** #2,000 of 5,301 · **top 38%**')
})

// --------------------------------------------------------------- activity

test('activity: windows of complete hours; averages only over hours the bot was listening', () => {
  const H = 3_600_000
  const now = Date.parse('2026-10-10T22:30:00Z')
  const current = Date.parse('2026-10-10T22:00:00Z')
  const rows = [
    { hour_start: current - H, started: 12 }, // last complete hour
    { hour_start: current - 2 * H, started: 8 },
    { hour_start: current - 25 * H, started: 10 }, // 21h UTC yesterday
    { hour_start: current, started: 5 }, // current hour: not complete yet
  ]
  const a = activitySummary(rows, now, 'UTC', hourOfDay)
  assert.deepEqual([a.lastHour, a.lastDay, a.lastWeek, a.lastMonth], [12, 20, 30, 30])
  assert.equal(a.perHourOfDay[21], 11) // (12 + 10) / 2 watched 21h-hours
  assert.equal(a.perHourOfDay[20], 8)
  assert.equal(a.perHourOfDay[3], null) // never watched
  const empty = activitySummary([], now, 'UTC', hourOfDay)
  assert.deepEqual([empty.lastHour, empty.since], [null, null])
})

test('pick names normalise between the site and stored games', () => {
  assert.equal(pickName('Yellow Deck'), 'yellow')
  assert.equal(pickName('yellow'), 'yellow')
  assert.equal(pickName('Cocktail Deck ~ Red, Blue, Plasma'), 'cocktail')
  assert.equal(pickName('Spectral+ Stake'), 'spectral+')
  assert.deepEqual(popularityFromCounts([{ name: 'a', games: 3 }, { name: 'b', games: 1 }]), [
    { name: 'a', games: 3, pickRate: 75 },
    { name: 'b', games: 1, pickRate: 25 },
  ])
})

test('own pick counts: one per distinct match (games are stored for both players)', () => {
  const store = new Store(':memory:')
  const row = (player_id: string, match_id: number, deck: string, stake: string): GameRow => ({
    ...game(match_id, 'x', 'win', 1),
    player_id,
    deck,
    stake,
  })
  store.upsertGames([row('a', 1, 'Yellow Deck', 'Gold Stake'), row('b', 1, 'Yellow Deck', 'Gold Stake'), row('a', 2, 'Zodiac Deck', 'Gold Stake')])
  assert.deepEqual(store.pickCounts('deck', 'season7'), [
    { name: 'Yellow Deck', games: 1 },
    { name: 'Zodiac Deck', games: 1 },
  ])
  assert.deepEqual(store.pickCounts('stake', 'season7'), [{ name: 'Gold Stake', games: 2 }])
  store.close()
})

// ------------------------------------------------------------------ search

test('player search: cached, and a longer query reuses a complete shorter one', async () => {
  const calls: string[] = []
  const api = {
    searchPlayers: async (q: string) => {
      calls.push(q)
      return [
        { id: '1', name: 'zombieman', mmr: 824 },
        { id: '2', name: 'zombie girl', mmr: 311 },
      ]
    },
  } as unknown as Api
  const dir = new Directory({ api, tracker: { players: new Map(), on: () => {} } as unknown as Tracker, queueId: '1' })
  assert.equal((await dir.search('zombie')).length, 2)
  assert.equal((await dir.search('zombie')).length, 2) // cached
  assert.deepEqual((await dir.search('zombiem')).map((h) => h.name), ['zombieman']) // filtered locally
  assert.deepEqual(await dir.search('z'), []) // too short to search
  assert.deepEqual(calls, ['zombie'])
})

// ---------------------------------------------------------------- storage

test('migration: opponent names are added to an existing games table', () => {
  const path = `${process.env.TEMP ?? '/tmp'}/tracklatro-migration-${Date.now()}.db`
  const old = new DatabaseSync(path)
  old.exec(`CREATE TABLE games (player_id TEXT NOT NULL, match_id INTEGER NOT NULL, played_at INTEGER NOT NULL, opponent_id TEXT NOT NULL,
    result TEXT NOT NULL, mmr_change REAL, deck TEXT, stake TEXT, season TEXT NOT NULL, duration_ms INTEGER, PRIMARY KEY (player_id, season, match_id))`)
  old.exec(`INSERT INTO games VALUES ('me', 1, 1000, 'x', 'win', 10, NULL, NULL, 'season7', NULL)`)
  old.close()
  const store = new Store(path)
  assert.equal(store.hasOpponentNames('me'), false) // old rows: a full refetch fills them in
  store.upsertGames([{ ...game(1, 'x', 'win', 10, 'Xavier'), player_id: 'me' }])
  assert.equal(store.hasOpponentNames('me'), true)
  assert.equal(store.gamesOf('me')[0]?.opponent_name, 'Xavier')
  store.close()
})

// ------------------------------------------------------------------ charts

test('new charts: ASCII text only, card art embedded, unwatched hours as dots', () => {
  const busy = busiestHoursSvg([...Array(23).fill(5), null], 3, 'Europe/Brussels', 12)
  assert.equal((busy.match(/<circle /g) ?? []).length, 1)
  const picks = popularitySvg('deck', [{ name: 'yellow', games: 9, pickRate: 90 }, { name: 'unknownthing', games: 1, pickRate: 10 }], 'season7')
  assert.equal((picks.match(/<image /g) ?? []).length, 1) // art for yellow, none for an unknown deck
  for (const svg of [busy, picks]) {
    for (const [, t] of svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)) assert.match(t!, /^[\x20-\x7e]*$/, `non-ASCII: ${t}`)
  }
})
