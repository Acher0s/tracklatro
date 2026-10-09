import assert from 'node:assert/strict'
import { type TestContext, test } from 'node:test'
import type { Api, RemotePlayerState } from './api.ts'
import type { Config } from './config.ts'
import type { MatchRecord } from './results.ts'
import { adaptiveMatchTimeout, type MatchOutcome, Tracker } from './tracker.ts'

const config = {
  topN: 100,
  hotIntervalMs: 10_000,
  warmIntervalMs: 30_000,
  hotCooldownMs: 600_000,
  warmWindowMs: 7_200_000,
  staleMatchMs: 3 * 3_600_000,
  staleQueueMs: 2 * 3_600_000,
} as Config

const T0 = Date.parse('2026-10-08T10:00:00Z')
const inGame = (opponentId: string, startTime = T0): RemotePlayerState => ({
  status: 'in_game',
  currentMatch: { opponentId, startTime },
})
const queuing = (since: number): RemotePlayerState => ({ status: 'queuing', queueStartTime: since })
const record = (opponentId: string): MatchRecord => ({
  matchId: 42,
  createdAt: T0 + 1_000,
  playerId: 'a',
  opponentId,
  won: true,
  mmrChange: 12,
  deck: 'Red Deck',
  stake: 'White Stake',
  gameType: 'ranked',
  season: 'season7',
})

/** Tracker with a scripted match history; lets tests run the result-lookup timers. */
function setup(t: TestContext, history: () => MatchRecord[], timeoutMs?: number) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let lookups = 0
  const tracker = new Tracker({
    api: {} as Api,
    config,
    isWatched: () => false,
    hasConsumers: () => true,
    history: async () => {
      lookups++
      return history()
    },
    matchTimeoutMs: timeoutMs === undefined ? undefined : () => timeoutMs,
  })
  const events: string[] = []
  const outcomes: Array<{ outcome: MatchOutcome; late: boolean }> = []
  tracker.on('queue_join', (e) => events.push(`join ${e.playerId}`))
  tracker.on('match_start', (m) => events.push(`start ${m.players.join('-')}`))
  tracker.on('match_end', (m) => events.push(`end ${m.players.join('-')}`))
  tracker.on('match_result', (_m, outcome) => outcomes.push({ outcome, late: Boolean(_m.lateResult) }))
  /** Advances fake time and lets the async history lookups settle. */
  const run = async (ms: number) => {
    t.mock.timers.tick(ms)
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
  }
  t.after(() => tracker.stop())
  return { tracker, events, outcomes, run, lookups: () => lookups }
}

const states = (o: Record<string, RemotePlayerState | null>) => new Map(Object.entries(o))

test('requeue after a cancelled match: settled by one immediate lookup', async (t) => {
  const { tracker, outcomes, run, lookups } = setup(t, () => [])
  tracker.observe(states({ a: inGame('b'), b: inGame('a') }), T0 + 60_000)
  tracker.observe(states({ a: queuing(T0 + 300_000), b: inGame('a') }), T0 + 310_000)
  await run(0)
  assert.equal(lookups(), 1)
  assert.deepEqual(outcomes, [{ outcome: { status: 'not_found' }, late: false }])
})

test('requeue after a finished match: result found immediately', async (t) => {
  const { tracker, outcomes, run } = setup(t, () => [record('b')])
  tracker.observe(states({ a: inGame('b'), b: inGame('a') }), T0 + 60_000)
  tracker.observe(states({ a: queuing(T0 + 300_000), b: null }), T0 + 310_000)
  await run(0)
  assert.equal(outcomes.length, 1)
  assert.equal(outcomes[0]?.outcome.status, 'found')
})

test('cleared state with a miss gets a safety-net second look before "no result"', async (t) => {
  const { tracker, outcomes, run, lookups } = setup(t, () => [])
  tracker.observe(states({ a: inGame('b') }), T0 + 60_000)
  tracker.observe(states({ a: null }), T0 + 310_000)
  await run(0)
  assert.equal(outcomes.length, 0)
  await run(20_000)
  assert.equal(lookups(), 2)
  assert.deepEqual(outcomes, [{ outcome: { status: 'not_found' }, late: false }])
})

test('the opponent stuck on a cancelled match is no longer shown in game, and is not re-announced', async (t) => {
  const { tracker, events, run } = setup(t, () => [])
  tracker.observe(states({ a: inGame('b'), b: inGame('a') }), T0 + 60_000)
  tracker.observe(states({ a: queuing(T0 + 300_000), b: inGame('a') }), T0 + 310_000)
  await run(0)
  // Next round: the site still shows b in the cancelled match.
  tracker.observe(states({ a: queuing(T0 + 300_000), b: inGame('a') }), T0 + 320_000)
  assert.equal(tracker.players.get('b')?.snapshot?.kind, 'idle')
  assert.equal(tracker.activeMatches.size, 0)
  // b eventually requeues: a normal queue join, nothing about the old match.
  tracker.observe(states({ b: queuing(T0 + 900_000) }), T0 + 910_000)
  assert.deepEqual(events, ['end a-b', 'join a', 'join b'])
})

test('a timed-out match is reported, and corrected if it turns out to have finished', async (t) => {
  let history: MatchRecord[] = []
  const { tracker, outcomes, run } = setup(t, () => history, 45 * 60_000)
  tracker.observe(states({ a: inGame('b'), b: inGame('a') }), T0 + 60_000)
  // Still "in game" past the timeout → treated as over, no result (yet).
  const timedOutAt = T0 + 50 * 60_000
  tracker.checkTimeouts(timedOutAt)
  await run(0)
  await run(20_000)
  assert.deepEqual(outcomes, [{ outcome: { status: 'not_found' }, late: false }])
  // The site keeps showing them in game; that's suppressed, not re-announced.
  tracker.observe(states({ a: inGame('b'), b: inGame('a') }), timedOutAt + 60_000)
  assert.equal(tracker.activeMatches.size, 0)

  // A long game after all: it finishes, the site clears both players.
  history = [record('b')]
  tracker.observe(states({ a: null, b: null }), timedOutAt + 10 * 60_000)
  await run(0)
  assert.equal(outcomes.length, 2)
  assert.equal(outcomes[1]?.outcome.status, 'found')
  assert.equal(outcomes[1]?.late, true)
})

test('after a restart, a stuck match that was already settled is ignored', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const settled = new Set(['a:b'])
  const tracker = new Tracker({
    api: {} as Api,
    config,
    isWatched: () => false,
    hasConsumers: () => true,
    history: async () => [],
    matchTimeoutMs: () => 45 * 60_000,
    wasEnded: (a, b) => settled.has(`${a}:${b}`),
  })
  t.after(() => tracker.stop())
  const events: string[] = []
  tracker.on('match_end', (m) => events.push(`end ${m.players.join('-')}`))
  tracker.on('match_result', (m) => events.push(`result ${m.players.join('-')}`))

  // Fresh start: the site still shows both cancelled matches as running, hours later.
  const later = T0 + 2 * 3_600_000 - 60_000
  tracker.observe(states({ a: inGame('b'), b: inGame('a'), c: inGame('d'), d: inGame('c') }), later)
  assert.equal(tracker.players.get('a')?.snapshot?.kind, 'idle')
  assert.equal(tracker.players.get('b')?.snapshot?.kind, 'idle')
  // Only the never-settled one is tracked (and then times out).
  assert.deepEqual(
    [...tracker.activeMatches].map((m) => m.players.join('-')),
    ['c-d']
  )
  tracker.checkTimeouts(later)
  assert.deepEqual(events, ['end c-d'])
  // Next rounds: a-b stays quiet, no re-registration.
  tracker.observe(states({ a: inGame('b'), b: inGame('a') }), later + 10_000)
  assert.equal(tracker.activeMatches.size, 0)
})

test('results update streaks like the queue bot: wins count up, losses count down', async (t) => {
  const { tracker, run } = setup(t, () => [record('b')]) // a beats b
  tracker.observe(states({ a: inGame('b'), b: inGame('a') }), T0 + 60_000)
  tracker.players.get('a')!.streak = -2
  tracker.players.get('b')!.streak = -1
  tracker.observe(states({ a: null, b: queuing(T0 + 400_000) }), T0 + 400_000)
  await run(0)
  assert.equal(tracker.players.get('a')?.streak, 1) // losing streak broken
  assert.equal(tracker.players.get('b')?.streak, -2) // second loss in a row
  assert.deepEqual(tracker.players.get('b')?.recentGames, [{ queuedAt: T0, endedAt: T0 + 400_000, won: false }])
  assert.equal(tracker.players.get('a')?.recentGames?.[0]?.won, true)
})

test('adaptiveMatchTimeout learns from completed match durations', () => {
  const min = 60_000
  assert.equal(adaptiveMatchTimeout([20 * min], 90 * min, 180 * min), 90 * min) // too few samples
  const durations = Array.from({ length: 100 }, (_, i) => (10 + (i % 30)) * min) // 10–39 min
  assert.equal(adaptiveMatchTimeout(durations, 90 * min, 180 * min), 39 * min * 1.25)
  assert.equal(adaptiveMatchTimeout(Array(50).fill(5 * min), 90 * min, 180 * min), 30 * min) // floor
  assert.equal(adaptiveMatchTimeout(Array(50).fill(170 * min), 90 * min, 180 * min), 180 * min) // cap
})
