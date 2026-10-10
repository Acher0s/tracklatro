/**
 * Content of the self-updating widgets, as plain data (rendered into an embed
 * by the bot). Pure, so the bot can compare renders and only edit on change.
 */

export type WidgetContent = { title: string; description: string; footer: string }

/** Embed descriptions max out at 4096 characters. */
const MAX_DESCRIPTION = 4000

/** Joins lines, cutting off with "…and N more" if they don't fit. */
export function fitLines(lines: string[], max = MAX_DESCRIPTION): string {
  let out = ''
  for (let i = 0; i < lines.length; i++) {
    const next = out ? `${out}\n${lines[i]}` : lines[i]!
    const more = `\n…and ${lines.length - i} more`
    if (next.length + (i < lines.length - 1 ? more.length : 0) > max) return `${out}${more}`
    out = next
  }
  return out
}

const ts = (ms: number) => `<t:${Math.floor(ms / 1000)}:R>`

export function matchesWidget(
  matches: Array<{ players: [string, string]; startTime: number }>,
  label: (id: string) => string,
  totalRunning?: number
): WidgetContent {
  const sorted = [...matches].sort((a, b) => b.startTime - a.startTime)
  return {
    title: `⚔️ Ongoing matches (${sorted.length})`,
    description: sorted.length
      ? fitLines(sorted.map((m) => `• ${label(m.players[0])} vs ${label(m.players[1])} · ${ts(m.startTime)}`))
      : '-# No tracked matches right now.',
    footer:
      totalRunning === undefined
        ? 'Tracked players only'
        : `${totalRunning} ranked match${totalRunning === 1 ? '' : 'es'} running in total · tracked players shown`,
  }
}

export function queueWidget(
  queuers: Array<{ id: string; since: number }>,
  label: (id: string) => string,
  totalQueued?: number
): WidgetContent {
  const sorted = [...queuers].sort((a, b) => a.since - b.since)
  return {
    title: `🟢 In queue (${sorted.length})`,
    description: sorted.length
      ? fitLines(sorted.map((q) => `• ${label(q.id)} · ${ts(q.since)}`))
      : '-# Nobody tracked is queuing right now.',
    footer:
      totalQueued === undefined
        ? 'Tracked players only'
        : `${totalQueued} in the ranked queue in total · tracked players shown`,
  }
}

export type RoleAlerts = {
  streak?: { channelId?: string; minStreak: number }
  tilt?: { channelId?: string; minLosses: number; ranged: boolean }
}

export function rolesWidget(alerts: RoleAlerts): WidgetContent {
  const where = (channelId?: string) => (channelId ? `in <#${channelId}> ` : '')
  const lines = ['Click a button to toggle a role.', '']
  if (alerts.streak) {
    lines.push(
      `🔥 **Win-streak alerts**: get pinged ${where(alerts.streak.channelId)}when someone on a ${alerts.streak.minStreak}+ win streak queues.`
    )
  }
  if (alerts.tilt) {
    lines.push(
      `😤 **Tilt-queue alerts**: get pinged ${where(alerts.tilt.channelId)}when someone who lost ${alerts.tilt.minLosses}+ in a row queues right back up.` +
        (alerts.tilt.ranged ? ' Pick the MMR range(s) you care about.' : '')
    )
  }
  return { title: '🔔 Notification roles', description: lines.join('\n'), footer: 'Click again to remove the role' }
}

// ------------------------------------------------------------------ activity

const HOUR_MS = 3_600_000

export type ActivitySummary = {
  /** Ranked matches started in each window of complete hours (null: the bot wasn't listening at all then). */
  lastHour: number | null
  lastDay: number | null
  lastWeek: number | null
  lastMonth: number | null
  /** Average matches started per hour of the day (in `timeZone`) over watched hours; null where never watched. */
  perHourOfDay: Array<number | null>
  /** Days of watched hours behind the averages. */
  days: number
  /** First hour the bot counted. */
  since: number | null
}

/**
 * Summarises ranked matches started per hour (counted live, see live.ts).
 * Only hours the bot was listening exist as rows, so downtime doesn't count
 * as quiet hours.
 */
export function activitySummary(
  rows: Array<{ hour_start: number; started: number }>,
  now: number,
  timeZone: string,
  hourOfDay: (ms: number, timeZone: string) => number,
  windowDays = 28
): ActivitySummary {
  const currentHour = Math.floor(now / HOUR_MS) * HOUR_MS
  const sumSince = (hours: number) => {
    const from = currentHour - hours * HOUR_MS
    const inWindow = rows.filter((r) => r.hour_start >= from && r.hour_start < currentHour)
    return inWindow.length ? inWindow.reduce((sum, r) => sum + r.started, 0) : null
  }
  const recent = rows.filter((r) => r.hour_start >= currentHour - windowDays * 24 * HOUR_MS && r.hour_start < currentHour)
  const totals = Array.from({ length: 24 }, () => ({ started: 0, hours: 0 }))
  for (const r of recent) {
    const t = totals[hourOfDay(r.hour_start, timeZone)]!
    t.started += r.started
    t.hours++
  }
  return {
    lastHour: sumSince(1),
    lastDay: sumSince(24),
    lastWeek: sumSince(24 * 7),
    lastMonth: sumSince(24 * 30),
    perHourOfDay: totals.map((t) => (t.hours ? t.started / t.hours : null)),
    days: Math.round(recent.length / 24),
    since: rows[0]?.hour_start ?? null,
  }
}

/** Pick rates from counts (e.g. from the bot's own known matches). */
export function popularityFromCounts(counts: Array<{ name: string; games: number }>): Array<{ name: string; games: number; pickRate: number }> {
  const total = counts.reduce((sum, c) => sum + c.games, 0)
  return counts.map((c) => ({ ...c, pickRate: total ? Math.round((c.games / total) * 1000) / 10 : 0 }))
}

/** Win-streak ping text. */
export function streakAlert(label: string, streak: number, roleId: string): string {
  return `🔥 ${label} is on a **${streak}-win streak** and just queued! <@&${roleId}>`
}

/** Tilt-queue ping text: one message, mentioning every role it's for. */
export function tiltAlert(label: string, losses: number, roleIds: string[]): string {
  return `😤 ${label} lost **${losses} in a row** and is queuing right back up! ${roleIds.map((id) => `<@&${id}>`).join(' ')}`
}

/** A tilt alert role, optionally only for players within an MMR range (either end open). */
export type TiltRole = { roleId: string; min?: number; max?: number }

/** "900–1100", "1200+", "≤ 800", "all MMR". */
export function rangeLabel(r: { min?: number; max?: number }): string {
  if (r.min !== undefined && r.max !== undefined) return `${r.min}–${r.max}`
  if (r.min !== undefined) return `${r.min}+`
  if (r.max !== undefined) return `≤ ${r.max}`
  return 'all MMR'
}

/** The roles to ping for a player: those whose range holds their MMR (unknown MMR: only open-for-all roles). */
export function tiltRolesFor(roles: readonly TiltRole[], mmr: number | undefined): string[] {
  return roles
    .filter((r) => {
      if (r.min === undefined && r.max === undefined) return true
      if (mmr === undefined) return false
      return (r.min === undefined || mmr >= r.min) && (r.max === undefined || mmr <= r.max)
    })
    .map((r) => r.roleId)
}

/** A game we saw finish: when the player queued for it, when it ended, and whether they won. */
export type RecentGame = { queuedAt: number; endedAt: number; won: boolean }

/**
 * Length of the tilt chain behind a queue at `queuedAt`: consecutive losses,
 * newest first, where each one was followed by a quick requeue (within
 * `windowMs` of it ending), for the next loss and finally for this queue.
 * Tilt-queuing when it's ≥ the minimum number of losses.
 *
 * Games we didn't see can't sneak into a chain: a whole game doesn't fit in a
 * "quick" gap. A requeue can look like it started slightly *before* we noticed
 * the previous game end (both between two polls), hence the bit of slack.
 */
export function tiltChain(games: readonly RecentGame[], queuedAt: number, windowMs: number, slackMs = 60_000): number {
  let next = queuedAt
  let losses = 0
  for (let i = games.length - 1; i >= 0; i--) {
    const game = games[i]!
    const quick = next >= game.endedAt - slackMs && next - game.endedAt <= windowMs
    if (game.won || !quick) break
    losses++
    next = game.queuedAt
  }
  return losses
}
