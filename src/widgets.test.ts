import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fitLines, matchesWidget, queueWidget, rolesWidget, streakAlert } from './widgets.ts'

const label = (id: string) => `**${id}**`

test('fitLines keeps what fits and says how much was cut', () => {
  assert.equal(fitLines(['a', 'b']), 'a\nb')
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i} ${'x'.repeat(50)}`)
  const out = fitLines(lines, 1000)
  assert.ok(out.length <= 1000)
  const shown = out.split('\n').filter((l) => l.startsWith('line')).length
  assert.ok(out.endsWith(`…and ${100 - shown} more`))
})

test('matches widget: newest first, totals in the footer', () => {
  const w = matchesWidget(
    [
      { players: ['a', 'b'], startTime: 1_000_000 },
      { players: ['c', 'd'], startTime: 2_000_000 },
    ],
    label,
    30
  )
  assert.equal(w.title, '⚔️ Ongoing matches (2)')
  assert.equal(w.description, '• **c** vs **d** · <t:2000:R>\n• **a** vs **b** · <t:1000:R>')
  assert.equal(w.footer, '30 ranked matches running in total · tracked players shown')
  assert.equal(matchesWidget([], label).description, '-# No tracked matches right now.')
})

test('queue widget: longest waiting first', () => {
  const w = queueWidget(
    [
      { id: 'late', since: 5_000_000 },
      { id: 'early', since: 1_000_000 },
    ],
    label,
    3
  )
  assert.equal(w.title, '🟢 In queue (2)')
  assert.equal(w.description, '• **early** · <t:1000:R>\n• **late** · <t:5000:R>')
  assert.equal(w.footer, '3 in the ranked queue in total · tracked players shown')
})

test('roles widget and streak alert text', () => {
  assert.match(rolesWidget('123', 5).description, /pinged in <#123> when someone on a 5\+ win streak queues/)
  assert.equal(streakAlert('**bacon**', 8, '999'), '🔥 **bacon** is on a **8-win streak** and just queued! <@&999>')
})
