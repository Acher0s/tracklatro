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

/** One ranked game from one player's side. */
export type GameRow = {
  player_id: string
  match_id: number
  played_at: number
  opponent_id: string
  result: 'win' | 'loss' | 'tie'
  /** null when only known from the opponent's side. */
  mmr_change: number | null
  deck: string | null
  stake: string | null
  /** 'season7', … ('' if unknown). Old seasons number their games differently, so ids are per season. */
  season: string
  /** The opponent's name at the time, from the site's history (null for games only the bot saw). */
  opponent_name?: string | null
  /** Only for games the bot watched (the site's history has no game length). */
  duration_ms: number | null
}

export type QueuePost = {
  player_id: string
  channel_id: string
  message_id: string
  content: string
  stage: string
}

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
      CREATE TABLE IF NOT EXISTS games (
        player_id   TEXT    NOT NULL,
        match_id    INTEGER NOT NULL,
        played_at   INTEGER NOT NULL,
        opponent_id TEXT    NOT NULL,
        result      TEXT    NOT NULL,
        mmr_change  REAL,
        deck        TEXT,
        stake       TEXT,
        season      TEXT    NOT NULL,
        duration_ms INTEGER,
        PRIMARY KEY (player_id, season, match_id)
      );
      CREATE TABLE IF NOT EXISTS history_sync (
        player_id TEXT    NOT NULL,
        season    TEXT    NOT NULL,
        complete  INTEGER NOT NULL,
        synced_at INTEGER NOT NULL,
        PRIMARY KEY (player_id, season)
      );
      CREATE TABLE IF NOT EXISTS user_settings (
        user_id TEXT NOT NULL,
        key     TEXT NOT NULL,
        value   TEXT NOT NULL,
        PRIMARY KEY (user_id, key)
      );
      CREATE TABLE IF NOT EXISTS activity_hours (
        hour_start INTEGER PRIMARY KEY,
        started    INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS feed_messages (
        player_a   TEXT    NOT NULL,
        player_b   TEXT    NOT NULL,
        started_at INTEGER NOT NULL,
        message_id TEXT    NOT NULL
      );
      CREATE TABLE IF NOT EXISTS queue_posts (
        player_id  TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        content    TEXT NOT NULL,
        stage      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS queue_posts_player ON queue_posts (player_id);
      CREATE TABLE IF NOT EXISTS queue_samples (
        gap     REAL    NOT NULL,
        wait_ms INTEGER NOT NULL,
        at      INTEGER NOT NULL
      );
    `)
    // Columns added after a table first shipped.
    const gameColumns = (this.#db.prepare('PRAGMA table_info(games)').all() as Array<{ name: string }>).map((c) => c.name)
    if (!gameColumns.includes('opponent_name')) this.#db.exec('ALTER TABLE games ADD COLUMN opponent_name TEXT')
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

  /** Followed players with their number of subscribers, most followed first. */
  watchedTargets(): Array<{ id: string; subscribers: number }> {
    return [...this.#byTarget]
      .map(([id, subs]) => ({ id, subscribers: subs.size }))
      .sort((a, b) => b.subscribers - a.subscribers)
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

  /** Whether this match (players sorted, start time ± slack) was already settled, e.g. before a restart. */
  matchEnded(a: string, b: string, startedAt: number, slackMs = 2 * 60_000): boolean {
    return (
      this.#db
        .prepare(
          `SELECT 1 FROM matches
           WHERE player_a = ? AND player_b = ? AND started_at BETWEEN ? AND ? AND ended_at IS NOT NULL LIMIT 1`
        )
        .get(a, b, startedAt - slackMs, startedAt + slackMs) !== undefined
    )
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

  // -------------------------------------------------------------------- games

  /**
   * Stores ranked games (one row per player per game). A row seen again keeps
   * what it already knew where the new copy doesn't know better: a game the
   * bot watched has a duration the site's history lacks, and the site's copy
   * has the MMR change a mirrored row (from the opponent's side) lacks.
   */
  upsertGames(rows: GameRow[]) {
    const stmt = this.#db.prepare(
      `INSERT INTO games (player_id, match_id, played_at, opponent_id, result, mmr_change, deck, stake, season, duration_ms, opponent_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (player_id, season, match_id) DO UPDATE SET
         played_at   = excluded.played_at,
         opponent_id = excluded.opponent_id,
         result      = excluded.result,
         mmr_change  = COALESCE(excluded.mmr_change, games.mmr_change),
         deck        = COALESCE(excluded.deck, games.deck),
         stake       = COALESCE(excluded.stake, games.stake),
         duration_ms = COALESCE(games.duration_ms, excluded.duration_ms),
         opponent_name = COALESCE(excluded.opponent_name, games.opponent_name)`
    )
    this.#db.exec('BEGIN')
    try {
      for (const r of rows) {
        stmt.run(r.player_id, r.match_id, r.played_at, r.opponent_id, r.result, r.mmr_change, r.deck, r.stake, r.season, r.duration_ms, r.opponent_name ?? null)
      }
      this.#db.exec('COMMIT')
    } catch (err) {
      this.#db.exec('ROLLBACK')
      throw err
    }
  }

  /** Whether this player's stored games include opponent names (games stored before names were kept don't). */
  hasOpponentNames(playerId: string): boolean {
    return this.#db.prepare('SELECT 1 FROM games WHERE player_id = ? AND opponent_name IS NOT NULL LIMIT 1').get(playerId) !== undefined
  }

  gamesOf(playerId: string): GameRow[] {
    return this.#db.prepare('SELECT * FROM games WHERE player_id = ? ORDER BY played_at').all(playerId) as GameRow[]
  }

  /**
   * Lengths of a player's ranked games that the bot watched: stored with the
   * game, or from the match log (games watched before stats existed).
   */
  gameDurations(playerId: string): number[] {
    const rows = this.#db
      .prepare(
        // Match log ids are the queue bot's (current seasons); old seasons never join.
        `SELECT COALESCE(g.duration_ms, m.ended_at - m.started_at) AS d
         FROM games g LEFT JOIN matches m ON m.match_id = g.match_id AND m.winner_id IS NOT NULL
         WHERE g.player_id = ?`
      )
      .all(playerId) as Array<{ d: number | null }>
    return rows.map((r) => r.d).filter((d): d is number => d !== null && d > 0)
  }

  historySync(playerId: string, season: string): { complete: boolean; synced_at: number } | undefined {
    const row = this.#db
      .prepare('SELECT complete, synced_at FROM history_sync WHERE player_id = ? AND season = ?')
      .get(playerId, season) as { complete: number; synced_at: number } | undefined
    return row && { complete: row.complete === 1, synced_at: row.synced_at }
  }

  setHistorySync(playerId: string, season: string, syncedAt: number) {
    this.#db
      .prepare(
        `INSERT INTO history_sync (player_id, season, complete, synced_at) VALUES (?, ?, 1, ?)
         ON CONFLICT (player_id, season) DO UPDATE SET complete = 1, synced_at = excluded.synced_at`
      )
      .run(playerId, season, syncedAt)
  }

  // ----------------------------------------------------------------- activity

  /**
   * Ranked matches started per hour, counted live. An hour row exists for
   * every hour the bot was listening (even with 0 starts), so averages only
   * use hours it actually saw.
   */
  addActivity(hourStart: number, started: number) {
    this.#db
      .prepare(
        `INSERT INTO activity_hours (hour_start, started) VALUES (?, ?)
         ON CONFLICT (hour_start) DO UPDATE SET started = started + excluded.started`
      )
      .run(hourStart, started)
  }

  activitySince(since: number): Array<{ hour_start: number; started: number }> {
    return this.#db
      .prepare('SELECT hour_start, started FROM activity_hours WHERE hour_start >= ? ORDER BY hour_start')
      .all(since) as Array<{ hour_start: number; started: number }>
  }

  /** Matches the bot tracked to a result, and since when. */
  trackedMatchCount(): { matches: number; since: number | null } {
    const row = this.#db
      .prepare('SELECT COUNT(*) AS n, MIN(started_at) AS since FROM matches WHERE winner_id IS NOT NULL')
      .get() as { n: number; since: number | null }
    return { matches: row.n, since: row.since }
  }

  /** Deck or stake per distinct ranked match the bot knows of in a season (games are stored once per player). */
  pickCounts(kind: 'deck' | 'stake', season: string): Array<{ name: string; games: number }> {
    return this.#db
      .prepare(
        `SELECT ${kind} AS name, COUNT(DISTINCT match_id) AS games FROM games
         WHERE season = ? AND ${kind} IS NOT NULL GROUP BY ${kind} ORDER BY games DESC, name`
      )
      .all(season)
      .map((r) => ({ name: String(r.name), games: Number(r.games) }))
  }

  // ------------------------------------------------------------ user settings

  getUserSetting(userId: string, key: string): string | undefined {
    return (
      this.#db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?').get(userId, key) as
        | { value: string }
        | undefined
    )?.value
  }

  setUserSetting(userId: string, key: string, value: string) {
    this.#db
      .prepare(
        `INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)
         ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value`
      )
      .run(userId, key, value)
  }

  // ----------------------------------------------------------------- settings

  getSetting(key: string): string | undefined {
    return (this.#db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value
  }

  setSetting(key: string, value: string) {
    this.#db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .run(key, value)
  }

  deleteSetting(key: string) {
    this.#db.prepare('DELETE FROM settings WHERE key = ?').run(key)
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

  // -------------------------------------------------------------- queue posts

  /** A "queued" message (feed or DM) whose color follows the player's queue session. */
  addQueuePost(post: QueuePost) {
    this.#db
      .prepare('INSERT INTO queue_posts (player_id, channel_id, message_id, content, stage) VALUES (?, ?, ?, ?, ?)')
      .run(post.player_id, post.channel_id, post.message_id, post.content, post.stage)
  }

  queuePosts(playerId: string): QueuePost[] {
    return this.#db.prepare('SELECT * FROM queue_posts WHERE player_id = ?').all(playerId) as QueuePost[]
  }

  setQueuePostStage(messageId: string, stage: string) {
    this.#db.prepare('UPDATE queue_posts SET stage = ? WHERE message_id = ?').run(stage, messageId)
  }

  /** Forgets a queue post (its session is over). */
  deleteQueuePost(messageId: string) {
    this.#db.prepare('DELETE FROM queue_posts WHERE message_id = ?').run(messageId)
  }

  /** Players with posts still being followed (to reconcile after a restart). */
  queuePostPlayers(): string[] {
    return (this.#db.prepare('SELECT DISTINCT player_id FROM queue_posts').all() as Array<{ player_id: string }>).map(
      (r) => r.player_id
    )
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
