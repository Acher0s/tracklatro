import type { RemotePlayerState } from './api.ts'

/** Normalised view of a player's state at one observation. */
export type Snapshot =
  | { kind: 'idle' }
  | { kind: 'queuing'; since: number }
  | { kind: 'in_game'; opponentId: string; startTime: number }

export type PlayerTransition =
  | { type: 'queue_join'; since: number }
  | { type: 'queue_leave'; since: number }
  | { type: 'match_start'; opponentId: string; startTime: number; sawQueue: boolean }
  | { type: 'match_end'; opponentId: string; startTime: number }

export type Staleness = { staleMatchMs: number; staleQueueMs: number }

/**
 * The site stores state in Redis from NeatQueue webhooks and never expires it,
 * so a missed MATCH_COMPLETED / LEAVE_QUEUE leaves a player "in game" forever.
 * Anything older than the staleness limits is treated as idle.
 */
export function normalize(remote: RemotePlayerState | null, now: number, limits: Staleness): Snapshot {
  if (remote?.status === 'queuing' && remote.queueStartTime !== undefined) {
    if (now - remote.queueStartTime > limits.staleQueueMs) return { kind: 'idle' }
    return { kind: 'queuing', since: remote.queueStartTime }
  }
  if (remote?.status === 'in_game' && remote.currentMatch?.opponentId) {
    const { opponentId, startTime } = remote.currentMatch
    if (now - startTime > limits.staleMatchMs) return { kind: 'idle' }
    return { kind: 'in_game', opponentId, startTime }
  }
  return { kind: 'idle' }
}

/**
 * Start times of one match can differ slightly: the two players' states are
 * written separately, and the queue bot retries webhooks, so a resent
 * MATCH_STARTED rewrites the state with a new start time a few seconds later.
 * A real rematch can't start this soon after the previous game did.
 */
export const SAME_MATCH_TOLERANCE_MS = 2 * 60_000

function sameMatch(a: Snapshot, b: Snapshot): boolean {
  return (
    a.kind === 'in_game' &&
    b.kind === 'in_game' &&
    a.opponentId === b.opponentId &&
    Math.abs(a.startTime - b.startTime) < SAME_MATCH_TOLERANCE_MS
  )
}

/**
 * Derives what happened between two observations of the same player.
 * Polling can skip intermediate states (e.g. queue → match within one poll,
 * or match end → instant rematch), so one step may yield several transitions.
 */
export function transitions(prev: Snapshot, next: Snapshot): PlayerTransition[] {
  const out: PlayerTransition[] = []

  if (prev.kind === 'in_game' && !sameMatch(prev, next)) {
    out.push({ type: 'match_end', opponentId: prev.opponentId, startTime: prev.startTime })
  }

  if (prev.kind === 'queuing') {
    if (next.kind === 'idle') out.push({ type: 'queue_leave', since: prev.since })
    // queuing → queuing with a new timestamp is a re-queue (e.g. into another
    // queue); not interesting enough to announce twice.
  }

  if (next.kind === 'queuing' && prev.kind !== 'queuing') {
    out.push({ type: 'queue_join', since: next.since })
  }

  if (next.kind === 'in_game' && !sameMatch(prev, next)) {
    out.push({
      type: 'match_start',
      opponentId: next.opponentId,
      startTime: next.startTime,
      sawQueue: prev.kind === 'queuing',
    })
  }

  return out
}
