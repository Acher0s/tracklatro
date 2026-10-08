import type { Store } from './db.ts'

export type QueueStage = 'queuing' | 'in_match' | 'done'
export const QUEUE_STAGE_EMOJI: Record<QueueStage, string> = { queuing: '🟢', in_match: '🟡', done: '⚪' }

/** Swaps the leading status emoji of a message, keeping everything after it. */
export function recolor(content: string, emoji: string): string {
  return content.replace(/^\S+/u, emoji)
}

/**
 * Keeps a player's "queued" posts (feed + DMs) colored by where their queue
 * session is: 🟢 queuing → 🟡 in a match → ⚪ over (left, or match finished).
 *
 * Every step only moves posts at the stage it expects. That keeps sessions
 * apart: when someone requeues right after a match, that match's result
 * arrives a moment later and grays its own 🟡 posts, not the new 🟢 ones.
 * Posts are persisted, so a restart mid-session can still settle them.
 */
export class QueuePosts {
  readonly #store: Store
  readonly #edit: (channelId: string, messageId: string, content: string) => Promise<void>
  /** The latest stage each player's session reached, for posts still being sent when it moved on. */
  readonly #stage = new Map<string, QueueStage>()

  constructor(store: Store, edit: (channelId: string, messageId: string, content: string) => Promise<void>) {
    this.#store = store
    this.#edit = edit
  }

  /** A new queue session starts: gray 🟢 posts of an earlier one we never saw end. */
  joined(playerId: string): Promise<void> {
    const stale = this.#advance(playerId, 'queuing', 'done')
    this.#stage.set(playerId, 'queuing')
    return stale
  }

  /** The "queued" messages of a session went out; catches them up if the session already moved on. */
  async posted(playerId: string, messages: Array<{ channelId: string; id: string; content: string }>) {
    for (const m of messages) {
      this.#store.addQueuePost({
        player_id: playerId,
        channel_id: m.channelId,
        message_id: m.id,
        content: m.content,
        stage: 'queuing',
      })
    }
    const stage = this.#stage.get(playerId)
    if (stage && stage !== 'queuing') await this.#advance(playerId, 'queuing', stage)
  }

  matched(playerId: string) {
    return this.#advance(playerId, 'queuing', 'in_match')
  }

  matchOver(playerId: string) {
    return this.#advance(playerId, 'in_match', 'done')
  }

  left(playerId: string) {
    return this.#advance(playerId, 'queuing', 'done')
  }

  /** After a restart: settle posts left from before using the first round of fresh states. */
  async reconcile(stateOf: (playerId: string) => 'idle' | 'queuing' | 'in_game' | undefined) {
    const work: Promise<void>[] = []
    for (const playerId of this.#store.queuePostPlayers()) {
      const state = stateOf(playerId)
      if (state === 'queuing') {
        this.#stage.set(playerId, 'queuing')
      } else if (state === 'in_game') {
        // The match is tracked from the baseline; its result grays these.
        this.#stage.set(playerId, 'in_match')
        work.push(this.#advance(playerId, 'queuing', 'in_match'))
      } else {
        work.push(this.#advance(playerId, 'queuing', 'done'), this.#advance(playerId, 'in_match', 'done'))
      }
    }
    await Promise.all(work)
  }

  async #advance(playerId: string, from: QueueStage, to: QueueStage) {
    if (this.#stage.get(playerId) === from) this.#stage.set(playerId, to)
    const posts = this.#store.queuePosts(playerId).filter((post) => post.stage === from)
    await Promise.all(
      posts.map(async (post) => {
        if (to === 'done') this.#store.deleteQueuePost(post.message_id)
        else this.#store.setQueuePostStage(post.message_id, to)
        await this.#edit(post.channel_id, post.message_id, recolor(post.content, QUEUE_STAGE_EMOJI[to]))
      })
    )
  }
}
