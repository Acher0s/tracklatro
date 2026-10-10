import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chunkLines, installLinks, playerLabel } from './bot.ts'

test('install links: to your own account, or to a server with the needed permissions', () => {
  const l = installLinks('123')
  assert.equal(l.user, 'https://discord.com/oauth2/authorize?client_id=123&integration_type=1&scope=applications.commands')
  assert.equal(
    l.server,
    'https://discord.com/oauth2/authorize?client_id=123&integration_type=0&scope=bot+applications.commands&permissions=268749824'
  )
  // View Channels, Send Messages, Embed Links, Attach Files, Use External Emojis, Manage Roles.
  assert.equal(1024 + 2048 + 16384 + 32768 + 262144 + 268435456, 268749824)
})

const url = 'https://balatromp.com/players/1'

test('playerLabel links the name when Discord allows it', () => {
  assert.equal(playerLabel('txmldw', url, '#481 · 697'), `[**txmldw**](<${url}>) (#481 · 697)`)
  // Markdown characters: escaped outside the link (escapes show literally inside link text).
  assert.equal(playerLabel('Blued_', url, '#596 · 666'), `**Blued\\_** [(#596 · 666)](<${url}>)`)
  assert.equal(playerLabel('_cool_', url), `**\\_cool\\_** [↗](<${url}>)`)
  assert.doesNotMatch(playerLabel('Blued_', url), /\[\*\*.*\\_.*\*\*\]/) // never an escape inside link text
  assert.equal(playerLabel('[clan] bob', url), `[**clan bob**](<${url}>)`)
})

test('playerLabel moves the link off names with emoji or invisible characters', () => {
  assert.equal(playerLabel('zombieman🧟', url, '#233 · 814'), `**zombieman🧟** [(#233 · 814)](<${url}>)`)
  assert.equal(playerLabel('🇧🇪 lex', url), `**🇧🇪 lex** [↗](<${url}>)`)
  assert.equal(playerLabel('zero​width', url, '900'), `**zero​width** [(900)](<${url}>)`)
  // Digits and # are technically "emoji" characters in Unicode, but are fine in links.
  assert.equal(playerLabel('player#1', url), `[**player#1**](<${url}>)`)
})

test('chunkLines keeps everything, never splits a line, and respects the limit', () => {
  const lines = Array.from({ length: 60 }, (_, i) => `• match ${i} ${'x'.repeat(150)}`)
  const chunks = chunkLines(lines)
  assert.ok(chunks.length > 1)
  for (const c of chunks) assert.ok(c.length <= 2000)
  assert.deepEqual(chunks.join('\n').split('\n'), lines)
})

test('chunkLines handles short input and oversized lines', () => {
  assert.deepEqual(chunkLines(['a', 'b']), ['a\nb'])
  assert.deepEqual(chunkLines([]), [])
  const huge = 'y'.repeat(4500)
  const chunks = chunkLines([huge], 2000)
  assert.deepEqual(
    chunks.map((c) => c.length),
    [2000, 2000, 500]
  )
  assert.equal(chunks.join(''), huge)
})
