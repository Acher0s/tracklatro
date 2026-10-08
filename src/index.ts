import { Api } from './api.ts'
import { Bot } from './bot.ts'
import { loadConfig } from './config.ts'
import { Store } from './db.ts'
import { Directory } from './directory.ts'
import { Predictor } from './predict.ts'
import { Tracker } from './tracker.ts'

const config = loadConfig()
const store = new Store(config.dbPath)
const api = new Api(config)
const tracker = new Tracker({
  api,
  config,
  isWatched: (id) => store.isWatched(id),
  hasConsumers: () => Boolean(config.feedChannelId) || store.hasAnySubscriptions(),
})
const directory = new Directory({ api, tracker, queueId: config.queueId })
const predictor = new Predictor({ api, config, store, tracker, directory })
const bot = new Bot({ config, store, tracker, api, predictor, directory })

tracker.on('queue_join', (e) => console.log(`[event] queue_join ${e.playerId}`))
tracker.on('queue_leave', (e) => console.log(`[event] queue_leave ${e.playerId}`))
tracker.on('match_start', (m) => console.log(`[event] match_start ${m.players.join(' vs ')}${m.late ? ' (late)' : ''}`))
tracker.on('match_result', (m, o) =>
  console.log(`[event] match_result ${m.players.join(' vs ')} → ${o.status === 'found' ? `#${o.result.match_id}` : o.status}`)
)

await bot.start()
await tracker.start()

const shutdown = () => {
  console.log('shutting down')
  tracker.stop()
  void bot.client.destroy()
  store.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
