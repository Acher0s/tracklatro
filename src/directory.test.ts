import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Api } from './api.ts'
import type { Config } from './config.ts'
import { Directory } from './directory.ts'
import { Tracker } from './tracker.ts'

const config = { topN: 100, hotIntervalMs: 10_000, warmIntervalMs: 30_000, hotCooldownMs: 600_000 } as Config

test('names outsiders from the leaderboard, falls back to Discord, batches and caches', async () => {
  const calls: string[][] = []
  let failNext = false
  const api = {
    fetchUserRanks: async (_q: string, ids: string[]) => {
      calls.push(ids)
      if (failNext) {
        failNext = false
        throw new Error('site down')
      }
      return new Map(ids.map((id) => [id, id === 'ranked' ? { name: 'Ranked Guy', mmr: 990, rank: 412 } : null]))
    },
  } as unknown as Api
  const tracker = new Tracker({ api, config, isWatched: () => false, hasConsumers: () => true })
  const directory = new Directory({ api, tracker, queueId: '1' })
  directory.discordName = async (id) => (id === 'casual' ? 'Casual Person' : undefined)

  // An opponent outside the top 100 shows up during a poll.
  tracker.heat('ranked')
  // Concurrent requests for the same ids share one lookup.
  await Promise.all([directory.ensure(['ranked', 'casual', 'ghost']), directory.ensure(['ranked'])])
  assert.deepEqual(calls, [['ranked', 'casual', 'ghost']])

  const p = tracker.players.get('ranked')!
  assert.equal(p.name, 'Ranked Guy')
  assert.equal(p.mmr, 990)
  assert.equal(p.globalRank, 412)
  assert.equal(p.rank, undefined) // still outside the tracked scope: no effect on tiers
  assert.equal(directory.get('casual')?.name, 'Casual Person')
  assert.equal(directory.get('ghost'), null)

  // Cached: no new request.
  await directory.ensure(['ranked', 'casual', 'ghost'])
  assert.equal(calls.length, 1)

  // A failed lookup isn't cached as "unknown"; it's retried next time.
  failNext = true
  await directory.ensure(['newbie'])
  assert.equal(directory.get('newbie'), undefined)
  await directory.ensure(['newbie'])
  assert.equal(calls.length, 3)
  assert.equal(directory.get('newbie'), null)

  tracker.stop()
})
