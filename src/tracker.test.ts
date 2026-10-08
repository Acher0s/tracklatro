import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Api, LeaderboardEntry, RemotePlayerState } from './api.ts'
import type { Config } from './config.ts'
import { Tracker } from './tracker.ts'

const config = {
  topN: 100,
  hotIntervalMs: 10_000,
  warmIntervalMs: 30_000,
  hotCooldownMs: 10 * 60_000,
  warmWindowMs: 2 * 3_600_000,
  staleMatchMs: 3 * 3_600_000,
  staleQueueMs: 2 * 3_600_000,
} as Config

function makeTracker(watched: string[] = [], cfg: Partial<Config> = {}) {
  const tracker = new Tracker({
    api: {} as Api,
    config: { ...config, ...cfg },
    isWatched: (id) => watched.includes(id),
    hasConsumers: () => true,
  })
  const events: string[] = []
  tracker.on('queue_join', (e) => events.push(`join ${e.playerId}`))
  tracker.on('queue_leave', (e) => events.push(`leave ${e.playerId}`))
  tracker.on('match_start', (m) =>
    events.push(`start ${m.players.join('-')}${m.unseenQueue.size ? ` unseen:${[...m.unseenQueue].join(',')}` : ''}`)
  )
  tracker.on('match_end', (m) => events.push(`end ${m.players.join('-')}`))
  return { tracker, events }
}

const entry = (id: string, games = 10): LeaderboardEntry => ({
  id,
  name: id,
  mmr: 1000,
  wins: games,
  losses: 0,
  streak: 0,
  rank: 0,
  winrate: 1,
})

const states = (o: Record<string, RemotePlayerState | null>) => new Map(Object.entries(o))
const inGame = (opponentId: string, startTime: number): RemotePlayerState => ({
  status: 'in_game',
  currentMatch: { opponentId, startTime },
})

test('first observation is a silent baseline; running matches are still tracked', () => {
  const { tracker, events } = makeTracker()
  tracker.observe(states({ a: inGame('b', 1000), b: inGame('a', 1001), c: null }), 2000)
  assert.deepEqual(events, [])
  assert.equal(tracker.activeMatches.size, 1)
})

test('a match seen from both players is announced once, after both views merge', () => {
  const { tracker, events } = makeTracker()
  tracker.observe(states({ a: null, b: null }), 0)
  tracker.observe(states({ a: { status: 'queuing', queueStartTime: 1 }, b: null }), 2)
  tracker.observe(states({ a: inGame('b', 50), b: inGame('a', 52) }), 60)
  // a was seen queuing, b went idle → in game within one poll.
  assert.deepEqual(events, ['join a', 'start a-b unseen:b'])

  tracker.observe(states({ a: null, b: null }), 70)
  assert.deepEqual(events.slice(2), ['end a-b'])
  tracker.stop()
})

test('a match is announced once when its players are seen going in on different polls', () => {
  const { tracker, events } = makeTracker()
  tracker.observe(states({ queuer: null, idle: null }), 0)
  tracker.observe(states({ queuer: { status: 'queuing', queueStartTime: 5_000 } }), 10_000)
  // The queuer is polled first and is already in the match...
  tracker.observe(states({ queuer: inGame('idle', 15_000) }), 20_000)
  // ...the idle player only on a later poll.
  tracker.observe(states({ queuer: inGame('idle', 15_000), idle: inGame('queuer', 15_000) }), 40_000)
  assert.deepEqual(events, ['join queuer', 'start idle-queuer'])
  assert.equal(tracker.activeMatches.size, 1)
  tracker.stop()
})

test('a resent MATCH_STARTED webhook (start time shifted by seconds) is not a new match', () => {
  const { tracker, events } = makeTracker()
  tracker.observe(states({ a: null, b: null }), 0)
  tracker.observe(states({ a: inGame('b', 100_000), b: inGame('a', 100_000) }), 110_000)
  tracker.observe(states({ a: inGame('b', 104_000), b: inGame('a', 104_000) }), 120_000)
  assert.deepEqual(events, ['start a-b unseen:a,b'])
  assert.equal(tracker.activeMatches.size, 1)
  tracker.stop()
})

test('instant rematch ends the old match and starts a new one', () => {
  const { tracker, events } = makeTracker()
  tracker.observe(states({ a: inGame('b', 1000) }), 1000)
  tracker.observe(states({ a: inGame('b', 10 * 60_000) }), 10 * 60_000)
  assert.deepEqual(events, ['end a-b', 'start a-b unseen:a'])
  assert.equal(tracker.activeMatches.size, 1)
  tracker.stop()
})

test('opponents are heated so they get polled next tick', () => {
  const { tracker } = makeTracker()
  tracker.observe(states({ a: null }), 0)
  tracker.observe(states({ a: inGame('z', 5) }), 10)
  const z = tracker.players.get('z')
  assert.ok(z)
  assert.equal(tracker.tier(z, 20), 'hot')
  tracker.stop()
})

test('tiers: hot / warm (top, watched, recently active) / cold', () => {
  const { tracker } = makeTracker(['w'], { topN: 0 })
  const now = 1_000_000
  const lb = [entry('top')]
  for (let i = 0; i < 150; i++) lb.push(entry(`p${i}`))
  lb.push(entry('w'))
  tracker.applyLeaderboard(lb, now)
  const tierOf = (id: string) => tracker.tier(tracker.players.get(id)!, now)
  assert.equal(tierOf('top'), 'warm') // rank 1
  assert.equal(tierOf('p140'), 'cold') // rank > 100
  assert.equal(tierOf('w'), 'warm') // subscribed
  // p140 finishes a game → leaderboard game count goes up → warm.
  lb[141] = entry('p140', 11)
  tracker.applyLeaderboard(lb, now + 60_000)
  assert.equal(tracker.tier(tracker.players.get('p140')!, now + 60_000), 'warm')
  tracker.observe(states({ p0: { status: 'queuing', queueStartTime: now } }), now)
  assert.equal(tierOf('p0'), 'hot')
})

test('selectBatch only requests when something is due, and fills spare slots with the stalest players', () => {
  const { tracker } = makeTracker([], { topN: 0 })
  const lb = Array.from({ length: 300 }, (_, i) => entry(`p${i}`))
  tracker.applyLeaderboard(lb, 0)
  // Everyone just polled.
  tracker.observe(new Map(lb.map((e) => [e.id, null])), 1_000_000)
  assert.deepEqual(tracker.selectBatch(1_005_000), [])

  // One hot player due → one full request of 100, rotating cold players in.
  tracker.observe(states({ p250: { status: 'queuing', queueStartTime: 1_000_000 } }), 1_000_000)
  const batch = tracker.selectBatch(1_010_000)
  assert.equal(batch.length, 100)
  assert.equal(batch[0], 'p250')

  // 30s later the top-100 warm players are due too: 101 due → 2 requests' worth.
  assert.equal(tracker.selectBatch(1_030_000).length, 200)
})
