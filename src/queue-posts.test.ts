import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Store } from './db.ts'
import { QueuePosts, recolor } from './queue-posts.ts'

function setup() {
  const store = new Store(':memory:')
  /** messageId → current content, as Discord would show it. */
  const shown = new Map<string, string>()
  const posts = new QueuePosts(store, async (_channel, id, content) => {
    shown.set(id, content)
  })
  let n = 0
  const post = (player: string) => {
    const id = `msg${++n}`
    const content = `🟢 **${player}** queued 3 seconds ago.\n🔮 extra forecast line`
    shown.set(id, content)
    return { channelId: 'chan', id, content }
  }
  const color = (id: string) => [...(shown.get(id) ?? '')][0]
  return { store, posts, post, color, shown }
}

test('recolor swaps only the leading emoji', () => {
  assert.equal(recolor('🟢 **a** queued.\n🔮 more', '🟡'), '🟡 **a** queued.\n🔮 more')
})

test('queuing → in a match → over', async () => {
  const { posts, post, color, shown, store } = setup()
  posts.joined('a')
  const feed = post('a')
  const dm = post('a')
  await posts.posted('a', [feed, dm])
  await posts.matched('a')
  assert.equal(color(feed.id), '🟡')
  assert.equal(color(dm.id), '🟡')
  assert.ok(shown.get(dm.id)?.endsWith('🔮 extra forecast line'))
  await posts.matchOver('a')
  assert.equal(color(feed.id), '⚪')
  assert.deepEqual(store.queuePosts('a'), []) // forgotten once settled
})

test('leaving the queue grays the posts', async () => {
  const { posts, post, color } = setup()
  posts.joined('a')
  const p = post('a')
  await posts.posted('a', [p])
  await posts.left('a')
  assert.equal(color(p.id), '⚪')
})

test("a requeue right after a match: the old match's result doesn't gray the new session", async () => {
  const { posts, post, color } = setup()
  posts.joined('a')
  const first = post('a')
  await posts.posted('a', [first])
  await posts.matched('a')
  // Match ends with a requeue; the new "queued" post goes out before the old result arrives.
  posts.joined('a')
  const second = post('a')
  await posts.posted('a', [second])
  await posts.matchOver('a') // result of the first match
  assert.equal(color(first.id), '⚪')
  assert.equal(color(second.id), '🟢')
})

test('matched while the "queued" posts were still being sent: they catch up', async () => {
  const { posts, post, color } = setup()
  posts.joined('a')
  await posts.matched('a') // nothing stored yet
  const p = post('a')
  await posts.posted('a', [p])
  assert.equal(color(p.id), '🟡')
})

test('after a restart, leftover posts follow the fresh state', async () => {
  const { store, post, color, shown } = setup()
  const before = new QueuePosts(store, async (_c, id, content) => void shown.set(id, content))
  before.joined('q')
  before.joined('g')
  before.joined('i')
  const [q, g, i] = [post('q'), post('g'), post('i')]
  await before.posted('q', [q])
  await before.posted('g', [g])
  await before.posted('i', [i])

  const after = new QueuePosts(store, async (_c, id, content) => void shown.set(id, content))
  const states = { q: 'queuing', g: 'in_game', i: 'idle' } as const
  await after.reconcile((id) => states[id as keyof typeof states])
  assert.equal(color(q.id), '🟢')
  assert.equal(color(g.id), '🟡')
  assert.equal(color(i.id), '⚪')
  await after.matchOver('g')
  assert.equal(color(g.id), '⚪')
})
