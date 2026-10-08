import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Api, LeaderboardEntry } from './api.ts'
import type { Config } from './config.ts'
import { Store } from './db.ts'
import { Directory } from './directory.ts'
import { Predictor } from './predict.ts'
import { Tracker } from './tracker.ts'

const config = {
  queueId: '1',
  topN: 100,
  hotIntervalMs: 10_000,
  warmIntervalMs: 30_000,
  hotCooldownMs: 600_000,
  warmWindowMs: 7_200_000,
  staleMatchMs: 10_800_000,
  staleQueueMs: 7_200_000,
  matchmaking: { searchStart: 0, searchIncrement: 10, instaqueue: [] },
} as unknown as Config

const entry = (id: string, mmr: number): LeaderboardEntry => ({
  id,
  name: id,
  mmr,
  wins: 1,
  losses: 1,
  streak: 0,
  rank: 0,
  winrate: 0.5,
})

test('forecast: likely opponent, personal estimate, unranked viewer, unseen queuers', async () => {
  const requested: string[][] = []
  const api = {
    fetchUserRanks: async (_q: string, ids: string[]) => {
      requested.push(ids)
      return new Map(ids.map((id) => [id, id === 'outsider' ? { name: 'Outsider', mmr: 1250, rank: 412 } : null]))
    },
    fetchQueueCounts: async () => new Map([['1', 4]]),
  } as unknown as Api
  const store = new Store(':memory:')
  const tracker = new Tracker({ api, config, isWatched: () => false, hasConsumers: () => true })
  const directory = new Directory({ api, tracker, queueId: '1' })
  const predictor = new Predictor({ api, config, store, tracker, directory })

  const now = Date.now()
  tracker.applyLeaderboard([entry('target', 1500), entry('rival', 1470), entry('me', 1400)], now)
  tracker.observe(
    new Map([
      ['target', { status: 'queuing', queueStartTime: now - 30_000 }],
      ['rival', { status: 'queuing', queueStartTime: now - 30_000 }],
      ['me', null],
    ]),
    now
  )

  const f = await predictor.forecast('target', ['me', 'outsider', 'nobody', 'target'])
  assert.ok(f)
  assert.equal(f.base.targetQueuing, true)
  assert.equal(f.base.visibleOthers, 1)
  assert.equal(f.base.unseen, 2) // 4 queued in total, 2 visible
  assert.equal(f.base.likely?.opponent, 'rival')

  const me = f.viewers.get('me')
  assert.equal(me?.kind, 'estimate')
  if (me?.kind === 'estimate') {
    assert.equal(me.gap, 100)
    assert.equal(me.outcome?.opponent, 'rival') // rival is closer and already in range
  }
  assert.equal(f.viewers.get('outsider')?.kind, 'estimate') // MMR looked up on the site
  assert.equal(f.viewers.get('nobody')?.kind, 'unranked')
  assert.equal(f.viewers.get('target')?.kind, 'self')
  // Only players missing from the tracker are looked up, in one batch, then cached.
  assert.deepEqual(requested, [['outsider', 'nobody']])
  await predictor.forecast('target', ['outsider'])
  assert.equal(requested.length, 1)

  tracker.stop()
  store.close()
})

test('forecast flags when the viewer is the one who gets the target', async () => {
  const api = {
    fetchUserRanks: async () => new Map(),
    fetchQueueCounts: async () => new Map([['1', 1]]),
  } as unknown as Api
  const store = new Store(':memory:')
  const tracker = new Tracker({ api, config, isWatched: () => false, hasConsumers: () => true })
  const directory = new Directory({ api, tracker, queueId: '1' })
  const predictor = new Predictor({ api, config, store, tracker, directory })

  const now = Date.now()
  tracker.applyLeaderboard([entry('target', 1361), entry('me', 1202)], now)
  tracker.observe(new Map([['target', { status: 'queuing', queueStartTime: now - 5_000 }], ['me', null]]), now)

  const me = (await predictor.forecast('target', ['me']))?.viewers.get('me')
  assert.equal(me?.kind, 'estimate')
  if (me?.kind === 'estimate') {
    assert.equal(me.outcome?.opponent, 'me')
    assert.equal(me.outcome?.isYou, true)
  }
  tracker.stop()
  store.close()
})
