import { Api } from './api.ts'
import { Bot } from './bot.ts'
import { loadConfig } from './config.ts'
import { Store } from './db.ts'
import { Directory } from './directory.ts'
import { LiveFeed } from './live.ts'
import { Predictor } from './predict.ts'
import { ResultSource } from './results.ts'
import { applySpeed, isSpeed } from './speed.ts'
import { StatsService } from './stats.ts'
import { adaptiveMatchTimeout, Tracker } from './tracker.ts'

const config = loadConfig()
const store = new Store(config.dbPath)
// Polling speed chosen with /setup speed (kept across restarts).
const savedSpeed = store.getSetting('poll_speed')
if (isSpeed(savedSpeed)) applySpeed(config, savedSpeed)
const api = new Api(config)
const results = new ResultSource(api)

// Learned from completed matches; recomputed at most every 10 minutes.
let matchTimeout = { ms: 0, at: 0 }
const matchTimeoutMs = () => {
  if (Date.now() - matchTimeout.at > 10 * 60_000) {
    const ms = adaptiveMatchTimeout(store.completedDurations(), config.matchTimeoutMs, config.staleMatchMs)
    matchTimeout = { ms, at: Date.now() }
  }
  return matchTimeout.ms
}

const tracker = new Tracker({
  api,
  config,
  isWatched: (id) => store.isWatched(id),
  hasConsumers: () =>
    Boolean(config.feedChannelId) ||
    store.hasAnySubscriptions() ||
    // Anything set up with /setup needs live data too.
    ['matches_channel', 'queue_channel', 'results_channel', 'streak_channel', 'tilt_channel'].some((key) =>
      store.getSetting(key)
    ),
  history: (id) => results.history(id),
  matchTimeoutMs,
  wasEnded: (a, b, startTime) => store.matchEnded(a, b, startTime),
})
const directory = new Directory({ api, tracker, queueId: config.queueId })
const predictor = new Predictor({ api, config, store, tracker, directory })
const stats = new StatsService({ api, store, results, tracker })
const bot = new Bot({ config, store, tracker, api, predictor, directory, stats, results })

tracker.on('queue_join', (e) => console.log(`[event] queue_join ${e.playerId}`))
tracker.on('queue_leave', (e) => console.log(`[event] queue_leave ${e.playerId}`))
tracker.on('match_start', (m) => console.log(`[event] match_start ${m.players.join(' vs ')}${m.late ? ' (late)' : ''}`))
tracker.on('match_result', (m, o) =>
  console.log(`[event] match_result ${m.players.join(' vs ')} → ${o.status === 'found' ? `#${o.result.matchId} (${o.result.deck ?? '?'}, ${o.result.stake ?? '?'})` : o.status}`)
)

const live = new LiveFeed({ api, store, tracker, predictor, maxPlayers: config.liveStreams, queueId: config.queueId })

await bot.start()
await tracker.start()
live.start()

const shutdown = () => {
  console.log('shutting down')
  live.stop()
  tracker.stop()
  void bot.client.destroy()
  store.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
