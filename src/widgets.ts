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

export function rolesWidget(streakChannelId: string | undefined, minStreak: number): WidgetContent {
  return {
    title: '🔔 Notification roles',
    description: [
      'Click a button to toggle a role.',
      '',
      `🔥 **Win-streak alerts**: get pinged ${streakChannelId ? `in <#${streakChannelId}> ` : ''}when someone on a ${minStreak}+ win streak queues.`,
    ].join('\n'),
    footer: 'Click again to remove the role',
  }
}

/** Win-streak ping text. */
export function streakAlert(label: string, streak: number, roleId: string): string {
  return `🔥 ${label} is on a **${streak}-win streak** and just queued! <@&${roleId}>`
}
