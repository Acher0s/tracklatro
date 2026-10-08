# tracklatro

A Discord bot that follows [Balatro Multiplayer](https://balatromp.com) queue states: who is queuing,
who got matched against whom, and how the game ended. Players can subscribe to someone and get a DM
when that person queues, finds a match, or finishes a game.

## Setup

Requires **Node.js 24+** (it runs the TypeScript directly and uses the built-in `node:sqlite`).

1. Create an application at <https://discord.com/developers/applications>, add a bot, and copy its token.
   No privileged intents are needed.
2. Invite it with the `bot` + `applications.commands` scopes. Optionally enable **User Install** so people
   can use the commands from their DMs without sharing a server with the bot.
3. Configure and run:

```bash
cp .env.example .env   # fill in DISCORD_TOKEN (and CONTACT, so the site maintainers can reach you)
npm install
npm start
```

Set `DISCORD_GUILD_ID` while developing so slash commands register instantly in that one server.
Set `FEED_CHANNEL_ID` for a public channel feed of queue joins and leaves, matches, and results for
the top players.

## Commands

| Command | |
| --- | --- |
| `/subscribe player [notify]` | DM me when they **queue** (join or leave), find a **match**, or get a **result** (default: everything) |
| `/unsubscribe player [notify]` | Stop all or some notifications |
| `/subscriptions` | Who you follow and what they're doing right now |
| `/status player` | Current state and recent tracked matches |
| `/live` | Everyone queuing or in a game right now |
| `/matchup player` | How long until you could queue into them, and who they'd likely get instead |
| `/recent [player]` | Recently tracked matches with results |
| `/about` | What's tracked and how many requests the bot has made |

If someone queues and gets matched between two polls, people subscribed only to **queue** still get
the "match found" message, because from their point of view that player did queue.

Deck and stake icons come from `assets/emoji/{decks,stakes}/*.png`. On startup the bot uploads any
missing ones as **application emojis** (`deck_yellow`, `stake_spectral_plus`, …). These belong to the
bot itself, so they work in DMs and any server, and they show up under **Emojis** in the developer
portal. A deck or stake without an image falls back to 🃏 / 🎲.

A result notification looks like this:

> 🏆 **bacon** (#1 · 1624) beat **Dominater** (#19 · 1200) · 🃏 Yellow Deck · 🎲 Spectral+ Stake · +12.2 for bacon · ⏱️ 23 min

In the feed channel, a match's ⚔️ "started" post is removed once the match is over, so the feed
only shows matches still being played, plus results.

"Queued" posts (feed and DMs) are edited as the session goes on: 🟢 while queuing, 🟡 once the
player is in a match, ⚪ when the match is over or they left the queue. A restart picks up where
it left off.

## Queue-time estimates

When a player someone follows joins the queue, each subscriber's DM adds a forecast:

> 🟢 **bacon** (#1 · 1624) queued 3 seconds ago.
> 🔮 Likely vs **yenn** (#2 · 1554) in ~4s · 1 other visible in queue (+1 I can't see).
> 🎯 If you queued now, you'd be in range in ~1 min (gap 144), but they'd likely be paired with **yenn** first (~4s).

`/matchup` and the `/subscribe` confirmation DM show the same forecast on demand.

These come from a model of the queue bot's matchmaker, ported from Botlatro's source
(`incrementEloCronJobAllQueues` in `src/utils/cronJobs.ts`) into `src/matchmaking.ts`. Only its
rules are reused; tracklatro never contacts Botlatro itself.

- A global tick runs **every 2 s**. The queue's `elo_search_speed` setting isn't used, because the
  tick interval is hard-coded.
- Every tick, each queued player's search range grows by `elo_search_increment`, starting from
  `elo_search_start`.
- Two players are a valid pair if their MMR gap is below **both** players' ranges, or if both fall
  inside an *instaqueue* band.
- Each tick, only the valid pair with the **smallest gap** is created, with at most one match every
  5 s globally.

Who the target is likely to get is worked out by playing that algorithm forward over the queuers the
bot can see (tracked players with a known MMR). For your personal line, you're added to the queue as
of now. The subscriber's own MMR comes from the tracker or, if they're outside the tracked range,
from the site's `leaderboard.get_user_rank` (batched, cached 30 min). If they're not on the ranked
leaderboard, the bot says so. The total queue size (`playerState.getActiveMatches`, cached 15 s) shows
how many queuers the bot *can't* see.

**Limitations.** These are speculations: they assume nobody joins or leaves, and queuers outside the
tracked set are invisible. Forecasts only run when a followed player queues, so they cost at most 2
extra site requests per event.

**Queue settings.** Botlatro only exposes its real queue settings through its authenticated API. The
model uses Botlatro's built-in defaults (`MM_SEARCH_START=0`, instaqueue bands `650-2000,0-450`) unless
you set them. If `MM_SEARCH_INCREMENT` isn't set, the bot **calibrates** it from matches it watches
happen. Each pairing where both queue joins were seen gives a lower bound
(`increment > gap / ticks waited`), and the bot uses the 75th percentile once it has 15 samples
(`/about` shows the current model). The best fix is to ask the maintainers for the real
"Standard Ranked" values and set them in `.env`.

## How it works

Everything comes from **balatromp.com's public tRPC API**; nothing else is contacted. There is no
push API, so the bot polls, and it's built to keep the request count low:

| Data | Procedure | Cost |
| --- | --- | --- |
| Live state (idle / queuing / in game + opponent) | `playerState.getState` | **1 request per 100 players** (tRPC request batching) |
| Who to track | `leaderboard.get_leaderboard` | every 10 min: 1 request for the top 100, 3 for the whole leaderboard |
| Game result (winner, MMR change, deck, stake) | `history.user_games_page` (newest 3 games) | 1 request per finished match (not per player), retried up to 4× |
| Active season (needed for history) | `seasons.list` | 1 request every 6 h |
| Names / MMR of players outside the top 100 | `leaderboard.get_user_rank` | batched, cached 30 min |
| Total queue size (forecasts only) | `playerState.getActiveMatches` | only when a followed player queues, cached 15 s |

The bot diffs consecutive snapshots to detect queue joins and leaves, match starts, and match ends. A
match that both players' snapshots report is merged into one event, so it's announced once.

### Tiers

Each player is polled at a frequency based on how likely something is about to happen:

| Tier | Who | Polled |
| --- | --- | --- |
| 🔥 hot | queuing, in game, or finished/left in the last 10 min (+ their opponents) | every 10 s |
| 🌤️ warm | top 100, anyone with a subscriber, anyone whose game count rose in the last 2 h | every 30 s |
| 🧊 cold | the rest of the leaderboard scope | never on its own |

A batched request costs the same whether it carries 10 or 100 players. Every request that goes out
is therefore filled up to 100 with the players who were polled longest ago, so cold players get
rotated through at no extra request cost. When a cold player finishes a game, their leaderboard
game count rises and they become warm.

### Expected request budget (balatromp.com)

| Setup | Requests / hour |
| --- | --- |
| Top 100, tiered (default) | ~360 at peak (one 100-player request every 10 s while anyone is hot), ~120 when quiet, +6 for the leaderboard |
| Whole leaderboard (`TOP_N=0`, ~5,300 players) | about the same polling (extra warm players share the spare slots until hot + warm > 100), +18 for the leaderboard (54 pages batched into 3 requests every 10 min, ~1.3 MB each time) |
| Naive: everyone every 20 s | ~9,700, which is why the bot doesn't do this |

With `TOP_N=0`, the full leaderboard is the main cost in bandwidth. Raise
`LEADERBOARD_REFRESH_MINUTES` to reduce it. The trade-off is that cold players are promoted to
warm later.

The bot pauses state polling entirely while nobody is subscribed and no feed channel is set.
On errors it backs off exponentially (up to 5 min) and honors `Retry-After`.

### Quirks handled

- **Stuck states.** The site only clears state when NeatQueue's webhook says so. Cancelled matches
  stay "in game" forever (some are days old). States older than `STALE_MATCH_HOURS` /
  `STALE_QUEUE_HOURS` count as idle.
- **Cancelled games** have no entry in the match history (it only lists completed games), and the
  queue bot sends the site nothing when a game is cancelled. How fast that's detected:
  - **A player requeues or starts another game:** right away. Their game must be closed for that,
    and results are recorded before a game closes, so one history lookup tells finished from
    cancelled.
  - **Nobody requeues:** the site keeps showing them "in game". After a timeout learned from how
    long completed games take (p99 × 1.25, 30 min to `STALE_MATCH_HOURS`; `MATCH_TIMEOUT_MINUTES`
    until there's enough data) it's reported as "no result (likely cancelled)". If it was just a
    long game and finishes later, the result is still posted, marked "finished after all".
  - The other player of a cancelled game stops showing as "in game" as soon as the game is known to
    be over.
- **"No result" vs "result unavailable":** the first means the site answered without the game, the
  second that the site couldn't be reached.
- **Rematches.** Only a game created between the match's start and its observed end is accepted as
  its result, so a later game against the same opponent is never mistaken for it.
- **Restarts.** The first observation of every player is a silent baseline. Running matches are still
  tracked so their results get reported, but they aren't re-announced.

## Development

```bash
npm test          # node:test unit tests (state machine, tiering, result matching, storage)
npm run typecheck
npm run dev       # restart on file changes
```

| File | |
| --- | --- |
| `src/api.ts` | Upstream client (tRPC batching, URL-length-aware chunking) |
| `src/state.ts` | Pure snapshot normalization + transition detection |
| `src/tracker.ts` | Tiered scheduler, match registry, result lookup, events |
| `src/results.ts` | Match history from the site, and matching a tracked match to its result |
| `src/directory.ts` | Names / MMR / rank for players outside the tracked range |
| `src/matchmaking.ts` | Model of Botlatro's matchmaker: ranges, simulation, calibration |
| `src/predict.ts` | Forecasts for a target + viewers (MMR lookup, queue counts, calibration samples) |
| `src/db.ts` | SQLite: subscriptions + match log |
| `src/bot.ts` | Discord commands, DMs, feed |
