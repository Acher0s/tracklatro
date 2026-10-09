import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isValidTimeZone, localTime, offsetLabel, quickPickZones, suggestTimeZones, utcOffsetMinutes } from './timezones.ts'

const NOW = Date.parse('2026-10-09T19:14:00Z')

test('validates IANA zones', () => {
  assert.equal(isValidTimeZone('Europe/Brussels'), true)
  assert.equal(isValidTimeZone('UTC'), true)
  assert.equal(isValidTimeZone('Mars/Olympus_Mons'), false)
})

test('local time per zone, for picking the one matching your clock', () => {
  assert.equal(localTime('UTC', NOW), '19:14')
  assert.equal(localTime('Europe/Brussels', NOW), '21:14') // CEST
  assert.equal(localTime('America/New_York', NOW), '15:14') // EDT
})

test('suggestions: typed text matches cities first, spaces and underscores alike', () => {
  const s = suggestTimeZones('new y', 'en-US', NOW)
  assert.equal(s[0]?.value, 'America/New_York')
  assert.equal(s[0]?.name, 'America/New York (now 15:14)')
  assert.ok(suggestTimeZones('brussels', undefined, NOW).some((z) => z.value === 'Europe/Brussels'))
  assert.ok(suggestTimeZones('', undefined, NOW).length <= 25)
  assert.ok(suggestTimeZones('e', undefined, NOW).length <= 25) // Discord's limit
})

test('UTC offsets follow daylight saving', () => {
  assert.equal(utcOffsetMinutes('Europe/Brussels', NOW), 120) // October: CEST
  assert.equal(utcOffsetMinutes('Europe/Brussels', Date.parse('2026-01-15T12:00:00Z')), 60) // CET
  assert.equal(utcOffsetMinutes('Asia/Kolkata', NOW), 330)
  assert.equal(utcOffsetMinutes('UTC', NOW), 0)
  assert.deepEqual([120, -210, 0, 330].map(offsetLabel), ['UTC+2', 'UTC-3:30', 'UTC', 'UTC+5:30'])
})

test('quick picker: one real zone per offset, current local times, language first', () => {
  const picks = quickPickZones('nl', NOW)
  assert.equal(picks.length, 25) // Discord's maximum
  assert.equal(new Set(picks.map((p) => p.description.split(' · ')[0])).size, 25) // all different offsets
  const plus2 = picks.find((p) => p.description.startsWith('UTC+2 '))!
  assert.equal(plus2.value, 'Europe/Amsterdam') // Dutch → Amsterdam rather than another UTC+2 zone
  assert.equal(plus2.label, '21:14 · Amsterdam')
  assert.ok(picks.some((p) => p.description.startsWith('UTC+5:30 '))) // India
  for (const p of picks) assert.ok(p.label.length <= 100 && p.description.length <= 100 && isValidTimeZone(p.value))
  // In January Amsterdam is UTC+1, so it moves to that slot.
  assert.equal(quickPickZones('nl', Date.parse('2026-01-15T12:00:00Z')).find((p) => p.description.startsWith('UTC+1 '))?.value, 'Europe/Amsterdam')
})

test('suggestions without text start with guesses for the Discord language', () => {
  assert.deepEqual(
    suggestTimeZones('', 'nl', NOW)
      .slice(0, 2)
      .map((z) => z.value),
    ['Europe/Amsterdam', 'Europe/Brussels']
  )
  assert.equal(suggestTimeZones('', 'pt-BR', NOW)[0]?.value, 'America/Sao_Paulo')
  assert.equal(suggestTimeZones('', 'xx', NOW)[0]?.value, 'UTC')
})
