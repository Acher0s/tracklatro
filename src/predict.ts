import type { Api } from './api.ts'
import type { Config } from './config.ts'
import type { Store } from './db.ts'
import type { Directory } from './directory.ts'
import {
  BOTLATRO_DEFAULTS,
  bothInInstaqueue,
  calibrateIncrement,
  type MatchmakingModel,
  matchFor,
  type Queuer,
  simulateQueue,
  timeUntilPairable,
} from './matchmaking.ts'
import type { TrackedMatch, Tracker } from './tracker.ts'

const QUEUE_COUNT_CACHE_MS = 15_000

export type Forecast = {
  targetId: string
  targetMmr: number
  /** Target is queuing right now (otherwise: "if they queued now"). */
  targetQueuing: boolean
  /** Other queuers we can see (tracked, known MMR). */
  visibleOthers: number
  /** Queuers we know exist but can't see (outside tracked set); null if unknown. */
  unseen: number | null
  /** Who the target likely gets from the visible queue (null = nobody within horizon). */
  likely: { opponent: string; opponentMmr: number; at: number } | null
}

export type ViewerForecast =
  | { kind: 'self' }
  | { kind: 'unranked' }
  | { kind: 'busy'; status: 'queuing' | 'in_game' }
  | {
      kind: 'estimate'
      mmr: number
      gap: number
      instaqueue: boolean
      /** If you queue now, when you and the target become pairable (ignoring everyone else). */
      pairableAt: number
      /** Simulated outcome with you in the queue: who the target ends up with. */
      outcome: { opponent: string; at: number } | null
    }

export class Predictor {
  readonly #api: Api
  readonly #cfg: Config
  readonly #store: Store
  readonly #tracker: Tracker
  readonly #directory: Directory
  #queueCount: { total: number | undefined; at: number } = { total: undefined, at: 0 }
  #model: MatchmakingModel
  #calibration: { increment: number; samples: number } | null = null

  constructor(opts: { api: Api; config: Config; store: Store; tracker: Tracker; directory: Directory }) {
    this.#api = opts.api
    this.#cfg = opts.config
    this.#store = opts.store
    this.#tracker = opts.tracker
    this.#directory = opts.directory
    this.#model = this.#buildModel()
    this.#tracker.on('match_start', (m) => this.#recordSample(m))
  }

  get model(): MatchmakingModel {
    return this.#model
  }

  /** Where the increment comes from, for /about. */
  get modelSource(): string {
    if (this.#cfg.matchmaking.searchIncrement !== undefined) return 'configured'
    if (this.#calibration) return `calibrated from ${this.#calibration.samples} observed pairings`
    const have = this.#store.queueSamples().length
    return `Botlatro default (calibrating: ${have} pairings observed so far)`
  }

  #buildModel(): MatchmakingModel {
    const mm = this.#cfg.matchmaking
    const base: MatchmakingModel = {
      ...BOTLATRO_DEFAULTS,
      searchStart: mm.searchStart,
      instaqueue: mm.instaqueue,
    }
    if (mm.searchIncrement !== undefined) return { ...base, searchIncrement: mm.searchIncrement }
    this.#calibration = calibrateIncrement(base, this.#store.queueSamples())
    return { ...base, searchIncrement: this.#calibration?.increment ?? BOTLATRO_DEFAULTS.searchIncrement }
  }

  /** Both queue joins observed → we know exactly how long the pairing took. */
  #recordSample(m: TrackedMatch) {
    const [a, b] = m.players
    const joinA = m.queueJoins.get(a)
    const joinB = m.queueJoins.get(b)
    const mmrA = this.#tracker.players.get(a)?.mmr
    const mmrB = this.#tracker.players.get(b)?.mmr
    if (joinA === undefined || joinB === undefined || mmrA === undefined || mmrB === undefined) return
    const waitMs = m.startTime - Math.max(joinA, joinB)
    if (waitMs < 0) return
    this.#store.addQueueSample(Math.abs(mmrA - mmrB), waitMs, m.startTime)
    this.#model = this.#buildModel()
  }

  // ------------------------------------------------------------------- inputs

  /** MMRs for players, from the tracker or the directory (null = not ranked / unknown). */
  async mmrs(ids: string[]): Promise<Map<string, number | null>> {
    await this.#directory.ensure(ids)
    return new Map(
      ids.map((id) => [id, this.#tracker.players.get(id)?.mmr ?? this.#directory.get(id)?.mmr ?? null])
    )
  }

  async #totalQueued(): Promise<number | undefined> {
    const now = Date.now()
    if (now - this.#queueCount.at > QUEUE_COUNT_CACHE_MS) {
      try {
        const counts = await this.#api.fetchQueueCounts()
        this.#queueCount = { total: counts.get(this.#cfg.queueId), at: now }
      } catch (err) {
        console.warn('[predict] queue count failed:', err instanceof Error ? err.message : err)
        this.#queueCount = { total: undefined, at: now }
      }
    }
    return this.#queueCount.total
  }

  /** Tracked players queuing right now with a known MMR. */
  #visibleQueue(): Queuer[] {
    const out: Queuer[] = []
    for (const p of this.#tracker.players.values()) {
      if (p.snapshot?.kind === 'queuing' && p.mmr !== undefined) {
        out.push({ id: p.id, mmr: p.mmr, joinedAt: p.snapshot.since })
      }
    }
    return out
  }

  // ----------------------------------------------------------------- forecast

  /**
   * Speculates who `targetId` will be paired with (if queuing now, or as if
   * they queued now) and, for `viewerIds`, what happens if each of them queued
   * right now. Returns null if the target's MMR is unknown.
   */
  async forecast(
    targetId: string,
    viewerIds: string[] = []
  ): Promise<{ base: Forecast; viewers: Map<string, ViewerForecast> } | null> {
    const now = Date.now()
    const mmrs = await this.mmrs([targetId, ...viewerIds])
    const targetMmr = mmrs.get(targetId)
    if (targetMmr == null) return null

    const visible = this.#visibleQueue()
    const target = this.#tracker.players.get(targetId)?.snapshot
    const targetQueuing = target?.kind === 'queuing'
    const queue = targetQueuing
      ? visible
      : [...visible.filter((q) => q.id !== targetId), { id: targetId, mmr: targetMmr, joinedAt: now }]
    const targetJoinedAt = queue.find((q) => q.id === targetId)!.joinedAt

    const total = await this.#totalQueued()
    const visibleQueued = visible.length
    const unseen = total === undefined ? null : Math.max(0, total - visibleQueued)

    const mmrOf = (id: string) => queue.find((q) => q.id === id)?.mmr ?? this.#tracker.players.get(id)?.mmr ?? 0
    const likelyMatch = matchFor(simulateQueue(this.#model, queue, now), targetId)
    const base: Forecast = {
      targetId,
      targetMmr,
      targetQueuing,
      visibleOthers: queue.length - 1,
      unseen,
      likely: likelyMatch ? { opponent: likelyMatch.opponent, opponentMmr: mmrOf(likelyMatch.opponent), at: likelyMatch.at } : null,
    }
    const viewers = new Map<string, ViewerForecast>()
    for (const viewerId of viewerIds) {
      viewers.set(viewerId, this.#viewer(viewerId, mmrs.get(viewerId), targetId, targetMmr, targetJoinedAt, queue, now))
    }
    return { base, viewers }
  }

  #viewer(
    viewerId: string,
    mmr: number | null | undefined,
    targetId: string,
    targetMmr: number,
    targetJoinedAt: number,
    queue: Queuer[],
    now: number
  ): ViewerForecast {
    if (viewerId === targetId) return { kind: 'self' }
    const status = this.#tracker.players.get(viewerId)?.snapshot?.kind
    if (status === 'queuing' || status === 'in_game') return { kind: 'busy', status }
    if (mmr == null) return { kind: 'unranked' }

    const pairableIn = timeUntilPairable(
      this.#model,
      { mmr, queuedMs: 0 },
      { mmr: targetMmr, queuedMs: now - targetJoinedAt }
    )
    const withYou = [...queue.filter((q) => q.id !== viewerId), { id: viewerId, mmr, joinedAt: now }]
    const outcome = matchFor(simulateQueue(this.#model, withYou, now), targetId)
    return {
      kind: 'estimate',
      mmr,
      gap: Math.abs(mmr - targetMmr),
      instaqueue: bothInInstaqueue(this.#model, mmr, targetMmr),
      pairableAt: now + pairableIn,
      outcome: outcome ? { opponent: outcome.opponent, at: outcome.at } : null,
    }
  }
}
