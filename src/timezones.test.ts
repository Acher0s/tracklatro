import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isValidTimeZone, localTime, suggestTimeZones } from './timezones.ts'

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
