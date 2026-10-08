/**
 * A model of Botlatro's matchmaker (Botlatro-Multiplayer/src/utils/cronJobs.ts,
 * `incrementEloCronJobAllQueues`), used to estimate queue times and speculate
 * about who will be paired with whom.
 *
 * How the real thing works, per queue:
 *  - A global tick runs every 2 s (hard-coded `speedDefault`; the queue's
 *    `elo_search_speed` setting is not used).
 *  - Each tick, every queued player's search range grows by
 *    `elo_search_increment`, starting from `elo_search_start` at join.
 *  - Two players are a valid pair if their MMR gap is strictly below BOTH
 *    players' ranges, or if both fall inside an "instaqueue" band.
 *  - Of all valid pairs, only the one with the smallest gap is created, at
 *    most one match per tick and at most one every 5 s globally.
 *
 * The real queue settings sit behind Botlatro's authenticated API, so the
 * parameters come from config (defaulting to Botlatro's own defaults) and can
 * be calibrated from observed matches; see `calibrateIncrement`.
 */

export type MatchmakingModel = {
  tickMs: number
  searchStart: number
  /** Range growth per tick. */
  searchIncrement: number
  /** Inclusive MMR bands; two players both inside the same band match instantly. */
  instaqueue: Array<[number, number]>
  /** Global minimum time between created matches. */
  cooldownMs: number
}

export const BOTLATRO_DEFAULTS: MatchmakingModel = {
  tickMs: 2_000,
  searchStart: 0,
  searchIncrement: 1,
  instaqueue: [
    [650, 2000],
    [0, 450],
  ],
  cooldownMs: 5_000,
}

export type Queuer = { id: string; mmr: number; joinedAt: number }

export function bothInInstaqueue(model: MatchmakingModel, a: number, b: number): boolean {
  return model.instaqueue.some(([lo, hi]) => a >= lo && a <= hi && b >= lo && b <= hi)
}

/** Ticks that have incremented a player's range after queueing for `queuedMs` (the first tick after joining counts). */
function ticksQueued(model: MatchmakingModel, queuedMs: number): number {
  return Math.max(0, Math.ceil(queuedMs / model.tickMs))
}

/** Search range after having been queued for `queuedMs`. */
export function rangeAfter(model: MatchmakingModel, queuedMs: number): number {
  return model.searchStart + model.searchIncrement * ticksQueued(model, queuedMs)
}

/** Ticks of queueing until a range strictly exceeds `gap` (at least 1: pairing happens on a tick). */
export function ticksToCover(model: MatchmakingModel, gap: number): number {
  if (model.searchIncrement <= 0) return Number.POSITIVE_INFINITY
  return Math.max(1, Math.floor((gap - model.searchStart) / model.searchIncrement) + 1)
}

/**
 * How long until two players *could* be paired, assuming both stay queued and
 * nobody better comes along. `queuedA/BMs` is how long each has already been
 * queued (0 = joins now).
 */
export function timeUntilPairable(
  model: MatchmakingModel,
  a: { mmr: number; queuedMs: number },
  b: { mmr: number; queuedMs: number }
): number {
  if (bothInInstaqueue(model, a.mmr, b.mmr)) return model.tickMs
  const needed = ticksToCover(model, Math.abs(a.mmr - b.mmr)) * model.tickMs
  return Math.max(model.tickMs, needed - a.queuedMs, needed - b.queuedMs)
}

export type SimulatedMatch = { a: string; b: string; at: number; gap: number }

/**
 * Plays the matchmaker forward over the currently known queue. Nobody new
 * joins and nobody leaves, so it's a speculation, not a prediction.
 */
export function simulateQueue(
  model: MatchmakingModel,
  queue: Queuer[],
  now: number,
  horizonMs = 30 * 60_000
): SimulatedMatch[] {
  const waiting = [...queue]
  const matches: SimulatedMatch[] = []
  let lastMatchAt = Number.NEGATIVE_INFINITY

  // Only times where something can change matter: the next tick, then each
  // tick at which some pair's ranges first cover their gap. Stepping tick by
  // tick is simple and cheap enough (≤ 900 ticks × n² for tiny n).
  for (let t = now + model.tickMs; t <= now + horizonMs && waiting.length >= 2; t += model.tickMs) {
    if (t - lastMatchAt < model.cooldownMs) continue
    let best: { i: number; j: number; gap: number } | undefined
    for (let i = 0; i < waiting.length; i++) {
      for (let j = i + 1; j < waiting.length; j++) {
        const p = waiting[i]!
        const q = waiting[j]!
        const gap = Math.abs(p.mmr - q.mmr)
        const valid =
          bothInInstaqueue(model, p.mmr, q.mmr) ||
          (gap < rangeAfter(model, t - p.joinedAt) && gap < rangeAfter(model, t - q.joinedAt))
        if (valid && (!best || gap < best.gap)) best = { i, j, gap }
      }
    }
    if (!best) continue
    const p = waiting[best.i]!
    const q = waiting[best.j]!
    matches.push({ a: p.id, b: q.id, at: t, gap: best.gap })
    waiting.splice(best.j, 1)
    waiting.splice(best.i, 1)
    lastMatchAt = t
  }
  return matches
}

/** The simulated match involving `id`, if any. */
export function matchFor(matches: SimulatedMatch[], id: string): { opponent: string; at: number; gap: number } | null {
  const m = matches.find((x) => x.a === id || x.b === id)
  return m ? { opponent: m.a === id ? m.b : m.a, at: m.at, gap: m.gap } : null
}

// ------------------------------------------------------------- calibration

/** A pairing we watched happen: MMR gap, and how long the later joiner had queued. */
export type QueueSample = { gap: number; waitMs: number }

/**
 * Estimates the per-tick range increment from observed pairings.
 *
 * When a pair with gap `g` is created after the later joiner waited `w`, their
 * range must have exceeded `g`: increment > (g − start) / ticks(w). Each
 * sample is therefore a lower bound. Matches delayed by other factors
 * (nobody else around, the cooldown) only loosen the bound, so a high
 * quantile is a reasonable estimate. Near-instant pairings are dropped
 * because they are explained by instaqueue bands, not by the range.
 */
export function calibrateIncrement(
  model: MatchmakingModel,
  samples: QueueSample[],
  minSamples = 15
): { increment: number; samples: number } | null {
  const minWaitMs = model.tickMs + model.cooldownMs
  const bounds = samples
    .filter((s) => s.waitMs >= minWaitMs && s.gap > model.searchStart)
    .map((s) => (s.gap - model.searchStart) / Math.max(1, ticksQueued(model, s.waitMs)))
    .sort((x, y) => x - y)
  if (bounds.length < minSamples) return null
  return { increment: bounds[Math.floor(bounds.length * 0.75)]!, samples: bounds.length }
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return 'never (range never grows)'
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 90) return `${m} min`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}
