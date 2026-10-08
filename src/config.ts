function str(name: string, fallback?: string): string {
  const value = process.env[name]?.trim()
  if (value) return value
  if (fallback !== undefined) return fallback
  throw new Error(`Missing required environment variable ${name}`)
}

function optional(name: string): string | undefined {
  return process.env[name]?.trim() || undefined
}

function num(name: string, fallback: number, min = 0): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`${name} must be a number >= ${min}, got "${raw}"`)
  }
  return value
}

/** "650-2000,0-450" → [[650, 2000], [0, 450]]; "" or "none" → no bands. */
function bands(raw: string): Array<[number, number]> {
  const trimmed = raw.trim()
  if (!trimmed || trimmed === 'none') return []
  return trimmed.split(',').map((part) => {
    const [lo, hi] = part.split('-').map((x) => Number(x.trim()))
    if (lo === undefined || hi === undefined || !Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) {
      throw new Error(`MM_INSTAQUEUE: invalid band "${part}" (expected e.g. 650-2000)`)
    }
    return [lo, hi]
  })
}

export function loadConfig() {
  return {
    discordToken: str('DISCORD_TOKEN'),
    guildId: optional('DISCORD_GUILD_ID'),
    feedChannelId: optional('FEED_CHANNEL_ID'),

    siteUrl: str('SITE_URL', 'https://balatromp.com').replace(/\/+$/, ''),
    botlatroUrl: str('BOTLATRO_URL', 'http://balatro.virtualized.dev:4931').replace(/\/+$/, ''),
    contact: optional('CONTACT'),

    queueId: str('QUEUE_ID', '1'),
    /** 0 = the entire leaderboard. */
    topN: num('TOP_N', 100, 0),
    // Hard floors so a typo can't turn the bot into a hammer.
    hotIntervalMs: num('HOT_POLL_SECONDS', 10, 5) * 1000,
    warmIntervalMs: num('WARM_POLL_SECONDS', 30, 10) * 1000,
    hotCooldownMs: num('HOT_COOLDOWN_MINUTES', 10, 0) * 60_000,
    warmWindowMs: num('WARM_WINDOW_HOURS', 2, 0) * 3_600_000,
    leaderboardRefreshMs: num('LEADERBOARD_REFRESH_MINUTES', 10, 5) * 60_000,
    staleMatchMs: num('STALE_MATCH_HOURS', 3, 0.5) * 3_600_000,
    staleQueueMs: num('STALE_QUEUE_HOURS', 2, 0.5) * 3_600_000,

    matchmaking: {
      searchStart: num('MM_SEARCH_START', 0),
      /** undefined = calibrate from observed matches, falling back to Botlatro's default of 1. */
      searchIncrement: optional('MM_SEARCH_INCREMENT') === undefined ? undefined : num('MM_SEARCH_INCREMENT', 1),
      instaqueue: bands(process.env.MM_INSTAQUEUE ?? '650-2000,0-450'),
    },

    dbPath: str('DB_PATH', './data/tracklatro.db'),
    maxSubscriptionsPerUser: num('MAX_SUBSCRIPTIONS_PER_USER', 25, 1),
  }
}

export type Config = ReturnType<typeof loadConfig>
