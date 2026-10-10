import type { Api, QueueCounts, RemotePlayerState } from './api.ts'
import type { Store } from './db.ts'
import type { Predictor } from './predict.ts'
import { Subscription } from './streams.ts'
import type { Tracker } from './tracker.ts'

type ActiveCounts = Array<{ queue_id: number; active_matches: number; players_in_queue: number }>

/** How often the set of followed players is checked for streams to open or close. */
const RECONCILE_EVERY_MS = 15_000
const HOUR_MS = 3_600_000

/** Ranked matches started between two counts: rises in the running count (falls are matches ending). */
export function startsBetween(previous: number | undefined, current: number): number {
  return previous === undefined ? 0 : Math.max(0, current - previous)
}

/**
 * Live updates pushed by the site, on top of polling:
 *  - `playerState.onActiveMatchesChange` fires whenever a match starts or ends
 *    anywhere: the tracker polls right away (within the speed setting's hot
 *    interval). Its counts come for free: queue sizes feed the forecasts, and
 *    rises in the running-match count are ranked matches starting, counted
 *    per hour for the activity widget;
 *  - `playerState.onStateChange` per followed player (the most followed first,
 *    up to `maxPlayers` open streams): their queue/match changes reach the
 *    tracker, and so subscribers' DMs, the moment the site knows.
 * Polling still covers everyone else, and queue joins of players nobody
 * follows (the trigger doesn't fire for those).
 */
export class LiveFeed {
  readonly #api: Api
  readonly #store: Store
  readonly #tracker: Tracker
  readonly #predictor: Predictor
  readonly #maxPlayers: number
  readonly #queueId: string
  /** Running matches in the tracked queue at the last count (undefined: not counting yet / reconnecting). */
  #running: number | undefined
  readonly #players = new Map<string, Subscription<RemotePlayerState | null>>()
  #matches: Subscription<ActiveCounts> | undefined
  #timer: NodeJS.Timeout | undefined

  constructor(opts: { api: Api; store: Store; tracker: Tracker; predictor: Predictor; maxPlayers: number; queueId: string }) {
    this.#api = opts.api
    this.#store = opts.store
    this.#tracker = opts.tracker
    this.#predictor = opts.predictor
    this.#maxPlayers = opts.maxPlayers
    this.#queueId = opts.queueId
  }

  start() {
    this.#matches = new Subscription<ActiveCounts>(this.#api, 'playerState.onActiveMatchesChange', null, (data, initial) => {
      this.#predictor.noteQueueCounts(
        new Map(data.map((q): [string, QueueCounts] => [String(q.queue_id), { queued: q.players_in_queue, running: q.active_matches }]))
      )
      if (!initial) this.#tracker.pollSoon()
      this.#countStarts(data, initial)
    }).start()
    this.reconcile()
    this.#timer = setInterval(() => {
      this.reconcile()
      // Mark the hour as watched even when nothing happens (quiet hours count as 0).
      if (this.#matches?.connected) this.#store.addActivity(hourStart(Date.now()), 0)
    }, RECONCILE_EVERY_MS)
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer)
    this.#matches?.stop()
    for (const s of this.#players.values()) s.stop()
    this.#players.clear()
  }

  #countStarts(data: ActiveCounts, initial: boolean) {
    const running = data.find((q) => String(q.queue_id) === this.#queueId)?.active_matches
    if (running === undefined) return
    // After (re)connecting, start counting from scratch: what happened while disconnected is unknown.
    const started = initial ? 0 : startsBetween(this.#running, running)
    this.#running = running
    this.#store.addActivity(hourStart(Date.now()), started)
  }

  /** Players with an open stream (for /about). */
  get streamedPlayers(): number {
    return this.#players.size
  }

  /** Opens streams for the most followed players, closes them for the rest. */
  reconcile() {
    const wanted = new Set(
      this.#store
        .watchedTargets()
        .slice(0, this.#maxPlayers)
        .map((t) => t.id)
    )
    for (const [id, sub] of this.#players) {
      if (!wanted.has(id)) {
        sub.stop()
        this.#players.delete(id)
      }
    }
    for (const id of wanted) {
      if (this.#players.has(id)) continue
      const sub = new Subscription<RemotePlayerState | null>(this.#api, 'playerState.onStateChange', { userId: id }, (state) =>
        this.#tracker.observe(new Map([[id, state]]), Date.now())
      )
      this.#players.set(id, sub.start())
    }
  }
}

function hourStart(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS
}
