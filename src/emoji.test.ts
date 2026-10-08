import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { emojiName } from './emoji.ts'

test('site labels and image file names map to the same emoji name', () => {
  assert.equal(emojiName('deck', 'Yellow Deck'), 'deck_yellow')
  assert.equal(emojiName('deck', 'yellow'), 'deck_yellow')
  assert.equal(emojiName('stake', 'Spectral+ Stake'), 'stake_spectral_plus')
  assert.equal(emojiName('stake', 'spectral+'), 'stake_spectral_plus')
  assert.equal(emojiName('stake', 'Spectral Stake'), 'stake_spectral')
  assert.equal(emojiName('stake', 'White Stake'), 'stake_white')
})

test('every bundled image gets a valid Discord emoji name', () => {
  const dir = fileURLToPath(new URL('../assets/emoji', import.meta.url))
  for (const [kind, folder] of [
    ['deck', 'decks'],
    ['stake', 'stakes'],
  ] as const) {
    for (const file of readdirSync(`${dir}/${folder}`)) {
      assert.match(emojiName(kind, file.replace(/\.png$/, '')), /^[a-z0-9_]{2,32}$/, file)
    }
  }
})
