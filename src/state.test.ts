import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalize, type Snapshot, transitions } from './state.ts'

const limits = { staleMatchMs: 3 * 3_600_000, staleQueueMs: 2 * 3_600_000 }
const idle: Snapshot = { kind: 'idle' }
const queuing: Snapshot = { kind: 'queuing', since: 1000 }
const game = (opponentId: string, startTime: number): Snapshot => ({ kind: 'in_game', opponentId, startTime })

test('normalize maps remote states and expires stale ones', () => {
  const now = 10 * 3_600_000
  assert.deepEqual(normalize(null, now, limits), idle)
  assert.deepEqual(normalize({ status: 'queuing', queueStartTime: now - 1000 }, now, limits), {
    kind: 'queuing',
    since: now - 1000,
  })
  assert.deepEqual(normalize({ status: 'queuing', queueStartTime: now - 3 * 3_600_000 }, now, limits), idle)
  assert.deepEqual(
    normalize({ status: 'in_game', currentMatch: { opponentId: 'b', startTime: now - 60_000 } }, now, limits),
    game('b', now - 60_000)
  )
  // Missed MATCH_COMPLETED webhook: stuck "in game" for 14h.
  assert.deepEqual(
    normalize({ status: 'in_game', currentMatch: { opponentId: 'b', startTime: now - 14 * 3_600_000 } }, now, limits),
    idle
  )
})

test('queue join and leave', () => {
  assert.deepEqual(transitions(idle, queuing), [{ type: 'queue_join', since: 1000 }])
  assert.deepEqual(transitions(queuing, idle), [{ type: 'queue_leave', since: 1000 }])
  assert.deepEqual(transitions(queuing, { kind: 'queuing', since: 2000 }), [])
  assert.deepEqual(transitions(idle, idle), [])
})

test('queue → match, including when the queue phase was never observed', () => {
  assert.deepEqual(transitions(queuing, game('b', 5)), [
    { type: 'match_start', opponentId: 'b', startTime: 5, sawQueue: true },
  ])
  assert.deepEqual(transitions(idle, game('b', 5)), [
    { type: 'match_start', opponentId: 'b', startTime: 5, sawQueue: false },
  ])
  assert.deepEqual(transitions(game('b', 5), game('b', 5)), [])
})

test('match end, re-queue and instant rematch within one poll', () => {
  assert.deepEqual(transitions(game('b', 5), idle), [{ type: 'match_end', opponentId: 'b', startTime: 5 }])
  assert.deepEqual(transitions(game('b', 5), queuing), [
    { type: 'match_end', opponentId: 'b', startTime: 5 },
    { type: 'queue_join', since: 1000 },
  ])
  const rematchAt = 25 * 60_000 // the next game vs the same opponent, after this one
  assert.deepEqual(transitions(game('b', 5), game('b', rematchAt)), [
    { type: 'match_end', opponentId: 'b', startTime: 5 },
    { type: 'match_start', opponentId: 'b', startTime: rematchAt, sawQueue: false },
  ])
})

test('a resent MATCH_STARTED (new start time, seconds later) is the same match', () => {
  assert.deepEqual(transitions(game('b', 1_000_000), game('b', 1_003_500)), [])
  // ...but not against someone else.
  assert.equal(transitions(game('b', 1_000_000), game('c', 1_003_500)).length, 2)
})
