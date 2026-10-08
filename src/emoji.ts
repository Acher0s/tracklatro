import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ApplicationEmojiManager } from 'discord.js'

export type EmojiKind = 'deck' | 'stake'

const FALLBACK: Record<EmojiKind, string> = { deck: '🃏', stake: '🎲' }

/**
 * Emoji name for a deck/stake, from either an image file name ("spectral+")
 * or the site's label ("Spectral+ Stake", "Yellow Deck"):
 * deck_yellow, stake_spectral_plus. Discord emoji names allow [A-Za-z0-9_], 2–32 chars.
 */
export function emojiName(kind: EmojiKind, label: string): string {
  const slug = label
    .toLowerCase()
    .replace(kind === 'deck' ? /\s*deck$/ : /\s*stake$/, '')
    .replace(/\+/g, '_plus')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return `${kind}_${slug}`.slice(0, 32)
}

/**
 * Deck and stake icons as application emojis: owned by the bot itself, so
 * they work in DMs and any server without the bot needing emoji slots there.
 * Images live in assets/emoji/{decks,stakes}/*.png; missing ones are uploaded
 * on startup, existing ones (matched by name) are reused.
 */
export class Emojis {
  readonly #byName = new Map<string, string>()

  async sync(manager: ApplicationEmojiManager, dir: string): Promise<void> {
    const existing = await manager.fetch()
    for (const emoji of existing.values()) {
      if (emoji.name) this.#byName.set(emoji.name, emoji.toString())
    }

    let uploaded = 0
    for (const [kind, folder] of [
      ['deck', 'decks'],
      ['stake', 'stakes'],
    ] as const) {
      let files: string[]
      try {
        files = (await readdir(join(dir, folder))).filter((f) => f.endsWith('.png'))
      } catch {
        continue // no images for this kind
      }
      for (const file of files) {
        const name = emojiName(kind, file.slice(0, -'.png'.length))
        if (this.#byName.has(name)) continue
        try {
          const emoji = await manager.create({ attachment: join(dir, folder, file), name })
          this.#byName.set(name, emoji.toString())
          uploaded++
        } catch (err) {
          console.warn(`[emoji] couldn't upload ${folder}/${file} as :${name}:`, err instanceof Error ? err.message : err)
        }
      }
    }
    const ours = [...this.#byName.keys()].filter((n) => n.startsWith('deck_') || n.startsWith('stake_')).length
    console.log(`[emoji] ${ours} deck/stake emojis ready (${uploaded} uploaded now)`)
  }

  /** The emoji for a deck/stake label from the site, or a generic fallback. */
  get(kind: EmojiKind, label: string): string {
    return this.#byName.get(emojiName(kind, label)) ?? FALLBACK[kind]
  }
}
