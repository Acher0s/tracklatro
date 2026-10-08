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
  tilt?: { channelId?: string; minLosses: number }
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
      `😤 **Tilt-queue alerts**: get pinged ${where(alerts.tilt.channelId)}when someone who lost ${alerts.tilt.minLosses}+ in a row queues right back up.`
    )
  }
  return { title: '🔔 Notification roles', description: lines.join('\n'), footer: 'Click again to remove the role' }
}

/** Win-streak ping text. */
export function streakAlert(label: string, streak: number, roleId: string): string {
  return `🔥 ${label} is on a **${streak}-win streak** and just queued! <@&${roleId}>`
}

/** Tilt-queue ping text. */
export function tiltAlert(label: string, losses: number, roleId: string): string {
  return `😤 ${label} lost **${losses} in a row** and is queuing right back up! <@&${roleId}>`
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
