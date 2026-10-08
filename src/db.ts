import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** Bit flags for what a subscriber wants to hear about. */
export const Notify = {
  queue: 1,
  match: 2,
  result: 4,
} as const
export type NotifyKind = keyof typeof Notify
export const NOTIFY_ALL = Notify.queue | Notify.match | Notify.result

export function describeMask(mask: number): string {
  const kinds = (Object.keys(Notify) as NotifyKind[]).filter((k) => mask & Notify[k])
  return kinds.length === 3 ? 'everything' : kinds.join(' + ')
}

export type Subscription = { user_id: string; target_id: string; mask: number; created_at: number }

export type MatchLogRow = {
  player_a: string
  player_b: string
  started_at: number
  ended_at: number | null
  match_id: number | null
  winner_id: string | null
}

export class Store {
  readonly #db: DatabaseSync
  /** target_id → (user_id → mask); hot path for every event, so kept in memory. */
  readonly #byTarget = new Map<string, Map<string, number>>()

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.#db = new DatabaseSync(path)
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS subscriptions (
        user_id    TEXT    NOT NULL,
        target_id  TEXT    NOT NULL,
        mask       INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, target_id)
      );
      CREATE INDEX IF NOT EXISTS subscriptions_target ON subscriptions (target_id);
      CREATE TABLE IF NOT EXISTS matches (
        player_a   TEXT    NOT NULL,
        player_b   TEXT    NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at   INTEGER,
        match_id   INTEGER,
        winner_id  TEXT,
        PRIMARY KEY (player_a, player_b, started_at)
      );
      CREATE INDEX IF NOT EXISTS matches_started ON matches (started_at DESC);
      CREATE TABLE IF NOT EXISTS feed_messages (
        player_a   TEXT    NOT NULL,
        player_b   TEXT    NOT NULL,
        started_at INTEGER NOT NULL,
        message_id TEXT    NOT NULL
      );
      CREATE TABLE IF NOT EXISTS queue_samples (
        gap     REAL    NOT NULL,
        wait_ms INTEGER NOT NULL,
        at      INTEGER NOT NULL
      );
    `)
    for (const s of this.#db.prepare('SELECT * FROM subscriptions').all() as Subscription[]) {
      this.#cache(s.user_id, s.target_id, s.mask)
    }
  }

  #cache(userId: string, targetId: string, mask: number) {
    let subs = this.#byTarget.get(targetId)
    if (mask === 0) {
      subs?.delete(userId)
      if (subs?.size === 0) this.#byTarget.delete(targetId)
      return
    }
    if (!subs) this.#byTarget.set(targetId, (subs = new Map()))
    subs.set(userId, mask)
  }

  // ------------------------------------------------------------ subscriptions

  subscribersOf(targetId: string): ReadonlyMap<string, number> {
    return this.#byTarget.get(targetId) ?? new Map()
  }

  isWatched(targetId: string): boolean {
    return this.#byTarget.has(targetId)
  }

  hasAnySubscriptions(): boolean {
    return this.#byTarget.size > 0
  }

  subscriptionsOf(userId: string): Subscription[] {
    return this.#db
      .prepare('SELECT * FROM subscriptions WHERE user_id = ? ORDER BY created_at')
      .all(userId) as Subscription[]
  }

  /** Adds kinds to a subscription (creating it); returns the resulting mask. */
  subscribe(userId: string, targetId: string, mask: number): number {
    const row = this.#db
      .prepare(
        `INSERT INTO subscriptions (user_id, target_id, mask, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id, target_id) DO UPDATE SET mask = mask | excluded.mask
         RETURNING mask`
      )
      .get(userId, targetId, mask, Date.now()) as { mask: number }
    this.#cache(userId, targetId, row.mask)
    return row.mask
  }

  /** Removes kinds from a subscription; returns the remaining mask (0 = gone). */
  unsubscribe(userId: string, targetId: string, mask = NOTIFY_ALL): number {
    const current = this.#byTarget.get(targetId)?.get(userId) ?? 0
    const remaining = current & ~mask
    if (remaining === 0) {
      this.#db.prepare('DELETE FROM subscriptions WHERE user_id = ? AND target_id = ?').run(userId, targetId)
    } else {
      this.#db
        .prepare('UPDATE subscriptions SET mask = ? WHERE user_id = ? AND target_id = ?')
        .run(remaining, userId, targetId)
    }
    this.#cache(userId, targetId, remaining)
    return remaining
  }

  // ---------------------------------------------------------------- match log

  logMatchStart(a: string, b: string, startedAt: number) {
    this.#db
      .prepare('INSERT OR IGNORE INTO matches (player_a, player_b, started_at) VALUES (?, ?, ?)')
      .run(a, b, startedAt)
  }

  logMatchResult(a: string, b: string, startedAt: number, endedAt: number, matchId: number | null, winnerId: string | null) {
    this.#db
      .prepare(
        `INSERT INTO matches (player_a, player_b, started_at, ended_at, match_id, winner_id) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (player_a, player_b, started_at)
         DO UPDATE SET ended_at = excluded.ended_at, match_id = excluded.match_id, winner_id = excluded.winner_id`
      )
      .run(a, b, startedAt, endedAt, matchId, winnerId)
  }

  /** How long recent completed matches took (start → observed end), for the match timeout. */
  completedDurations(limit = 500): number[] {
    const rows = this.#db
      .prepare(
        `SELECT ended_at - started_at AS d FROM matches
         WHERE winner_id IS NOT NULL AND ended_at IS NOT NULL ORDER BY started_at DESC LIMIT ?`
      )
      .all(limit) as Array<{ d: number }>
    return rows.map((r) => r.d).filter((d) => d > 0)
  }

  recentMatches(limit: number, playerId?: string): MatchLogRow[] {
    return (
      playerId
        ? this.#db
            .prepare('SELECT * FROM matches WHERE player_a = ? OR player_b = ? ORDER BY started_at DESC LIMIT ?')
            .all(playerId, playerId, limit)
        : this.#db.prepare('SELECT * FROM matches ORDER BY started_at DESC LIMIT ?').all(limit)
    ) as MatchLogRow[]
  }

  // ------------------------------------------------------------ feed messages

  /** Remembers the feed's "match started" post so it can be removed when the match is over. */
  addFeedMessage(a: string, b: string, startedAt: number, messageId: string) {
    this.#db
      .prepare('INSERT INTO feed_messages (player_a, player_b, started_at, message_id) VALUES (?, ?, ?, ?)')
      .run(a, b, startedAt, messageId)
  }

  /**
   * Removes and returns the start post(s) of a match. Matched with a little
   * slack on the start time: the two players' views of it differ by a few ms,
   * and a restart may re-learn it from the other player.
   */
  takeFeedMessages(a: string, b: string, startedAt: number, slackMs = 2 * 60_000): string[] {
    const where = 'player_a = ? AND player_b = ? AND started_at BETWEEN ? AND ?'
    const args = [a, b, startedAt - slackMs, startedAt + slackMs] as const
    const rows = this.#db.prepare(`SELECT message_id FROM feed_messages WHERE ${where}`).all(...args) as Array<{
      message_id: string
    }>
    this.#db.prepare(`DELETE FROM feed_messages WHERE ${where}`).run(...args)
    return rows.map((r) => r.message_id)
  }

  // ------------------------------------------------------- matchmaking samples

  addQueueSample(gap: number, waitMs: number, at: number) {
    this.#db.prepare('INSERT INTO queue_samples (gap, wait_ms, at) VALUES (?, ?, ?)').run(gap, waitMs, at)
  }

  /** Most recent pairings we observed from queue join to match (newest first). */
  queueSamples(limit = 500): Array<{ gap: number; waitMs: number }> {
    return this.#db
      .prepare('SELECT gap, wait_ms AS waitMs FROM queue_samples ORDER BY at DESC LIMIT ?')
      .all(limit) as Array<{ gap: number; waitMs: number }>
  }

  close() {
    this.#db.close()
  }
}
