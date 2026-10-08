import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chunkLines } from './bot.ts'

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
