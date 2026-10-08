import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fitLines, matchesWidget, queueWidget, rolesWidget, streakAlert, tiltAlert, tiltChain } from './widgets.ts'

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

test('roles widget lists only the configured alerts', () => {
  const both = rolesWidget({ streak: { channelId: '123', minStreak: 5 }, tilt: { minLosses: 2 } }).description
  assert.match(both, /pinged in <#123> when someone on a 5\+ win streak queues/)
  assert.match(both, /Tilt-queue alerts\*\*: get pinged when someone who lost 2\+ in a row queues right back up/)
  assert.doesNotMatch(rolesWidget({ tilt: { minLosses: 3 } }).description, /Win-streak/)
})

test('alert texts', () => {
  assert.equal(streakAlert('**bacon**', 8, '999'), '🔥 **bacon** is on a **8-win streak** and just queued! <@&999>')
  assert.equal(tiltAlert('**yenn**', 3, '42'), '😤 **yenn** lost **3 in a row** and is queuing right back up! <@&42>')
})

test('tiltChain: losses back to back, each followed by a quick requeue', () => {
  const min = 60_000
  const window = 5 * min
  const game = (queuedAt: number, endedAt: number, won = false) => ({ queuedAt, endedAt, won })
  // Loss 1 ends at 20 min, requeue at 22, loss 2 ends at 45, requeue now (47).
  const tilting = [game(0, 20 * min), game(22 * min, 45 * min)]
  assert.equal(tiltChain(tilting, 47 * min, window), 2)
  // Requeued between two polls: looks like it started just before we saw the game end.
  assert.equal(tiltChain(tilting, 45 * min - 8_000, window), 2)
  // Took a break after the last loss: no tilt.
  assert.equal(tiltChain(tilting, 55 * min, window), 0)
  // A break between the two losses: only the last one counts.
  assert.equal(tiltChain([game(0, 20 * min), game(40 * min, 60 * min)], 61 * min, window), 1)
  // A win in between breaks the chain.
  assert.equal(tiltChain([game(0, 20 * min), game(21 * min, 40 * min, true), game(41 * min, 60 * min)], 61 * min, window), 1)
  // Three quick losses.
  assert.equal(tiltChain([game(0, 20 * min), game(21 * min, 40 * min), game(41 * min, 60 * min)], 61 * min, window), 3)
  assert.equal(tiltChain([], 0, window), 0)
})
