import assert from 'node:assert/strict'
import { test } from 'node:test'
import { describeMask, NOTIFY_ALL, Notify, Store } from './db.ts'

test('subscriptions merge kinds, partially unsubscribe, and stay cached', () => {
  const store = new Store(':memory:')
  assert.equal(store.subscribe('u1', 'p1', Notify.queue), Notify.queue)
  assert.equal(store.subscribe('u1', 'p1', Notify.result), Notify.queue | Notify.result)
  store.subscribe('u2', 'p1', NOTIFY_ALL)

  assert.equal(store.isWatched('p1'), true)
  assert.deepEqual([...store.subscribersOf('p1')], [['u1', 5], ['u2', 7]])
  assert.equal(describeMask(5), 'queue + result')
  assert.equal(describeMask(NOTIFY_ALL), 'everything')

  assert.equal(store.unsubscribe('u1', 'p1', Notify.queue), Notify.result)
  assert.equal(store.unsubscribe('u1', 'p1'), 0)
  assert.equal(store.unsubscribe('u2', 'p1'), 0)
  assert.equal(store.isWatched('p1'), false)
  assert.equal(store.hasAnySubscriptions(), false)
  store.close()
})

test('feed start posts are found with start-time slack and only taken once', () => {
  const store = new Store(':memory:')
  store.addFeedMessage('a', 'b', 100_000, 'msg1')
  store.addFeedMessage('a', 'c', 100_000, 'other')
  assert.deepEqual(store.takeFeedMessages('a', 'b', 100_050), ['msg1']) // other player's view: a few ms off
  assert.deepEqual(store.takeFeedMessages('a', 'b', 100_050), [])
  assert.deepEqual(store.takeFeedMessages('a', 'c', 100_000 + 10 * 60_000), []) // a different (later) match
  store.close()
})

test('match log upserts results onto started matches', () => {
  const store = new Store(':memory:')
  store.logMatchStart('a', 'b', 100)
  store.logMatchResult('a', 'b', 100, 200, 42, 'b')
  store.logMatchResult('a', 'c', 300, 400, null, null)
  const rows = store.recentMatches(10, 'a')
  assert.equal(rows.length, 2)
  assert.deepEqual({ ...rows[1] }, { player_a: 'a', player_b: 'b', started_at: 100, ended_at: 200, match_id: 42, winner_id: 'b' })
  store.close()
})
