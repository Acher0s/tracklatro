import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chunkLines, playerLabel } from './bot.ts'

const url = 'https://balatromp.com/players/1'

test('playerLabel links the name when Discord allows it', () => {
  assert.equal(playerLabel('txmldw', url, '#481 · 697'), `[**txmldw**](<${url}>) (#481 · 697)`)
  assert.equal(playerLabel('a_b*', url), `[**a\\_b\\***](<${url}>)`)
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
