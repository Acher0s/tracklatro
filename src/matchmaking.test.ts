import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BOTLATRO_DEFAULTS,
  calibrateIncrement,
  formatDuration,
  type MatchmakingModel,
  matchFor,
  rangeAfter,
  simulateQueue,
  ticksToCover,
  timeUntilPairable,
} from './matchmaking.ts'

const noInsta: MatchmakingModel = { ...BOTLATRO_DEFAULTS, searchIncrement: 10, instaqueue: [] }
const now = 1_000_000

test('range grows per 2s tick, counting the first tick after joining', () => {
  assert.equal(rangeAfter(noInsta, 0), 0)
  assert.equal(rangeAfter(noInsta, 1), 10)
  assert.equal(rangeAfter(noInsta, 2_000), 10)
  assert.equal(rangeAfter(noInsta, 2_001), 20)
})

test('ranges must strictly exceed the gap', () => {
  assert.equal(ticksToCover(noInsta, 0), 1)
  assert.equal(ticksToCover(noInsta, 10), 2) // range 10 is not > 10
  assert.equal(ticksToCover(noInsta, 95), 10)
  assert.equal(ticksToCover({ ...noInsta, searchIncrement: 0 }, 5), Number.POSITIVE_INFINITY)
})

test('time until pairable is bound by whoever joined last', () => {
  // gap 200 → 21 ticks = 42s; target already queued 30s, you join now → 42s.
  assert.equal(timeUntilPairable(noInsta, { mmr: 1300, queuedMs: 0 }, { mmr: 1500, queuedMs: 30_000 }), 42_000)
  // Both already queued long enough → next tick.
  assert.equal(timeUntilPairable(noInsta, { mmr: 1300, queuedMs: 60_000 }, { mmr: 1500, queuedMs: 60_000 }), 2_000)
  // Instaqueue band → next tick regardless of gap.
  assert.equal(timeUntilPairable(BOTLATRO_DEFAULTS, { mmr: 700, queuedMs: 0 }, { mmr: 1900, queuedMs: 0 }), 2_000)
})

test('simulation pairs the smallest gap first and leaves the odd one out', () => {
  const sims = simulateQueue(
    noInsta,
    [
      { id: 'A', mmr: 1500, joinedAt: now },
      { id: 'B', mmr: 1490, joinedAt: now },
      { id: 'C', mmr: 1300, joinedAt: now },
    ],
    now,
    10 * 60_000
  )
  assert.deepEqual(sims[0], { a: 'A', b: 'B', at: now + 4_000, gap: 10 })
  assert.equal(matchFor(sims, 'C'), null)
})

test('a closer player gets the target before you would', () => {
  const queue = [
    { id: 'target', mmr: 1500, joinedAt: now - 60_000 },
    { id: 'other', mmr: 1460, joinedAt: now - 60_000 },
    { id: 'you', mmr: 1300, joinedAt: now },
  ]
  assert.equal(matchFor(simulateQueue(noInsta, queue, now), 'target')?.opponent, 'other')
  // Without the other player, you get them once your range covers the gap of 200.
  const alone = matchFor(simulateQueue(noInsta, [queue[0]!, queue[2]!], now), 'target')
  assert.deepEqual(alone, { opponent: 'you', at: now + 42_000, gap: 200 })
})

test('only one match per 5s globally', () => {
  const sims = simulateQueue(
    BOTLATRO_DEFAULTS,
    ['a', 'b', 'c', 'd'].map((id, i) => ({ id, mmr: 1000 + i, joinedAt: now })),
    now
  )
  assert.deepEqual(
    sims.map((m) => m.at - now),
    [2_000, 8_000]
  )
})

test('calibration recovers the increment from observed pairings and ignores instant ones', () => {
  const truth: MatchmakingModel = { ...BOTLATRO_DEFAULTS, searchIncrement: 5, instaqueue: [] }
  const samples = []
  for (let gap = 20; gap <= 400; gap += 20) {
    samples.push({ gap, waitMs: ticksToCover(truth, gap) * truth.tickMs })
  }
  samples.push({ gap: 900, waitMs: 2_000 }) // instaqueue pairing: dropped
  const est = calibrateIncrement(BOTLATRO_DEFAULTS, samples)
  assert.ok(est)
  assert.ok(est.increment > 4.5 && est.increment <= 5, `estimated ${est.increment}`)
  assert.equal(calibrateIncrement(BOTLATRO_DEFAULTS, samples.slice(0, 5)), null)
})

test('formatDuration', () => {
  assert.equal(formatDuration(42_000), '42s')
  assert.equal(formatDuration(11 * 60_000), '11 min')
  assert.equal(formatDuration(200 * 60_000), '3h 20m')
})
