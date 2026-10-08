#!/usr/bin/env bash
# Lists everyone's subscriptions, grouped by subscriber.
#
#   ./scripts/subscriptions.sh            # with names (one batched request to the site)
#   ./scripts/subscriptions.sh --ids      # ids only, no network
#
# Reads DB_PATH / SITE_URL from the app's .env (defaults: ./data/tracklatro.db,
# https://balatromp.com). Opens the database read-only, so it's safe to run
# while the bot is running.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source <(grep -E '^(DB_PATH|SITE_URL|QUEUE_ID)=' .env)
  set +a
fi
export DB_PATH="${DB_PATH:-./data/tracklatro.db}"
export SITE_URL="${SITE_URL:-https://balatromp.com}"
export QUEUE_ID="${QUEUE_ID:-1}"
export NO_NAMES=$([[ "${1:-}" == "--ids" ]] && echo 1 || echo 0)

if [[ ! -f "$DB_PATH" ]]; then
  echo "No database at $DB_PATH (has the bot run yet?)" >&2
  exit 1
fi

exec node --disable-warning=ExperimentalWarning --input-type=module - <<'JS'
import { DatabaseSync } from 'node:sqlite'

const db = new DatabaseSync(process.env.DB_PATH, { readOnly: true })
const subs = db.prepare('SELECT user_id, target_id, mask, created_at FROM subscriptions ORDER BY user_id, created_at').all()
db.close()

if (subs.length === 0) {
  console.log('No subscriptions yet.')
  process.exit(0)
}

const kinds = (mask) => {
  const k = [mask & 1 && 'queue', mask & 2 && 'match', mask & 4 && 'result'].filter(Boolean)
  return k.length === 3 ? 'everything' : k.join(' + ')
}

// Names from the site's leaderboard (one batched tRPC request per ~50 players).
const names = new Map()
if (process.env.NO_NAMES !== '1') {
  const ids = [...new Set(subs.flatMap((s) => [s.user_id, s.target_id]))]
  try {
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50)
      const input = Object.fromEntries(chunk.map((user_id, j) => [j, { json: { channel_id: process.env.QUEUE_ID, user_id } }]))
      const url =
        `${process.env.SITE_URL}/api/trpc/${chunk.map(() => 'leaderboard.get_user_rank').join(',')}` +
        `?batch=1&input=${encodeURIComponent(JSON.stringify(input))}`
      const res = await fetch(url, {
        headers: { 'User-Agent': 'tracklatro/0.1 (subscriptions script)' },
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      const items = await res.json()
      items.forEach((item, j) => {
        const entry = item?.result?.data?.json?.data
        if (entry) names.set(chunk[j], `${entry.name} (#${entry.rank} · ${Math.round(entry.mmr)})`)
      })
    }
  } catch (err) {
    console.error(`(couldn't look up names: ${err.message}; showing ids)\n`)
  }
}
const who = (id) => (names.has(id) ? `${names.get(id)} [${id}]` : id)
const date = (ms) => new Date(ms).toISOString().slice(0, 10)

const bySubscriber = Map.groupBy(subs, (s) => s.user_id)
for (const [userId, list] of bySubscriber) {
  console.log(`${who(userId)} — ${list.length} subscription${list.length === 1 ? '' : 's'}`)
  for (const s of list) console.log(`  → ${who(s.target_id)}: ${kinds(s.mask)} (since ${date(s.created_at)})`)
  console.log()
}

const followers = [...Map.groupBy(subs, (s) => s.target_id)].sort((a, b) => b[1].length - a[1].length)
console.log(`${bySubscriber.size} subscribers, ${subs.length} subscriptions, ${followers.length} players followed.`)
console.log('Most followed:')
for (const [targetId, list] of followers.slice(0, 5)) console.log(`  ${list.length}× ${who(targetId)}`)
JS
