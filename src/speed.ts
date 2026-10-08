import type { Config } from './config.ts'

/**
 * Polling speed presets. One state request carries up to 100 players, so with
 * the top 100 the cost is about one request per tick: the hot interval sets
 * the pace while anyone is queuing / playing, the warm interval when it's quiet
 * (and how late an idle top player's queue can be noticed).
 */
export const SPEEDS = ['eco', 'normal', 'fast'] as const
export type Speed = (typeof SPEEDS)[number]

const PRESETS: Record<Exclude<Speed, 'normal'>, { hotIntervalMs: number; warmIntervalMs: number }> = {
  eco: { hotIntervalMs: 20_000, warmIntervalMs: 60_000 },
  fast: { hotIntervalMs: 5_000, warmIntervalMs: 10_000 },
}

export function isSpeed(value: string | undefined): value is Speed {
  return (SPEEDS as readonly string[]).includes(value ?? '')
}

/** Intervals of a preset; `normal` is whatever .env configures (default 10 s / 30 s). */
export function speedIntervals(cfg: Config, speed: Speed): { hotIntervalMs: number; warmIntervalMs: number } {
  return speed === 'normal' ? cfg.normalSpeed : PRESETS[speed]
}

/** Switches the live config; the tracker picks the new intervals up on its next tick. */
export function applySpeed(cfg: Config, speed: Speed) {
  Object.assign(cfg, speedIntervals(cfg, speed))
  cfg.speed = speed
}

/** Rough site requests per hour (top 100: one request per tick). */
export function requestsPerHour(intervals: { hotIntervalMs: number; warmIntervalMs: number }): { busy: number; quiet: number } {
  return { busy: Math.round(3_600_000 / intervals.hotIntervalMs), quiet: Math.round(3_600_000 / intervals.warmIntervalMs) }
}

export function describeSpeed(cfg: Config, speed: Speed): string {
  const i = speedIntervals(cfg, speed)
  const r = requestsPerHour(i)
  return `**${speed}**: active players every ${i.hotIntervalMs / 1000}s, idle top players every ${i.warmIntervalMs / 1000}s (~${r.busy} requests/h busy, ~${r.quiet} quiet)`
}
