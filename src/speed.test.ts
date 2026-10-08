import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Api, LeaderboardEntry } from './api.ts'
import type { Config } from './config.ts'
import { applySpeed, isSpeed, requestsPerHour, speedIntervals } from './speed.ts'
import { Tracker } from './tracker.ts'

const config = () =>
  ({
    topN: 100,
    hotIntervalMs: 10_000,
    warmIntervalMs: 30_000,
    normalSpeed: { hotIntervalMs: 10_000, warmIntervalMs: 30_000 },
    speed: 'normal',
    hotCooldownMs: 600_000,
    warmWindowMs: 7_200_000,
    staleMatchMs: 10_800_000,
    staleQueueMs: 7_200_000,
  }) as Config

test('presets switch the live intervals; normal restores the .env values', () => {
  const cfg = config()
  applySpeed(cfg, 'fast')
  assert.deepEqual([cfg.speed, cfg.hotIntervalMs, cfg.warmIntervalMs], ['fast', 5_000, 10_000])
  applySpeed(cfg, 'eco')
  assert.deepEqual([cfg.hotIntervalMs, cfg.warmIntervalMs], [20_000, 60_000])
  applySpeed(cfg, 'normal')
  assert.deepEqual([cfg.speed, cfg.hotIntervalMs, cfg.warmIntervalMs], ['normal', 10_000, 30_000])
  assert.equal(isSpeed('fast'), true)
  assert.equal(isSpeed('ludicrous'), false)
  assert.deepEqual(requestsPerHour(speedIntervals(cfg, 'fast')), { busy: 720, quiet: 360 })
})

test('the tracker picks up a new speed on its next round', () => {
  const cfg = config()
  const tracker = new Tracker({ api: {} as Api, config: cfg, isWatched: () => false, hasConsumers: () => true })
  const entry = (id: string): LeaderboardEntry => ({ id, name: id, mmr: 1000, wins: 1, losses: 1, streak: 0, rank: 0, winrate: 0.5 })
  tracker.applyLeaderboard([entry('idle')], 0)
  tracker.observe(new Map([['idle', null]]), 1_000_000)
  // Normal: an idle top player isn't due again 12 s later...
  assert.deepEqual(tracker.selectBatch(1_012_000), [])
  // ...on fast they are.
  applySpeed(cfg, 'fast')
  assert.deepEqual(tracker.selectBatch(1_012_000), ['idle'])
})
