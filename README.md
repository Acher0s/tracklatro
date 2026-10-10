# tracklatro

A Discord bot that follows [Balatro Multiplayer](https://balatromp.com) queue states: who is queuing,
who got matched against whom, and how the game ended. Players can subscribe to someone and get a DM
when that person queues, finds a match, or finishes a game.

## Setup

Requires **Node.js 24+** (it runs the TypeScript directly and uses the built-in `node:sqlite`).

1. Create an application at <https://discord.com/developers/applications>, add a bot, and copy its token.
   No privileged intents are needed.
2. Add it to a server with the `bot` + `applications.commands` scopes and the **View Channels**,
   **Send Messages**, **Embed Links**, **Attach Files**, **Use External Emojis** and **Manage Roles**
   permissions. Once it runs,
   `/install` gives the links. Optionally enable **User Install** so people can use the commands
   anywhere, including DMs and servers the bot isn't in.
3. Configure and run:

```bash
cp .env.example .env   # fill in DISCORD_TOKEN (and CONTACT, so the site maintainers can reach you)
npm install
npm start
```

Set `DISCORD_GUILD_ID` while developing so slash commands register instantly in that one server.
Commands registered that way exist **only** in that server, not in DMs. Leave it empty in production;
the bot then registers everywhere and removes the server-only copies (and vice versa).
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
| `/stats player [public]` | Ranked stats over all seasons (see below) |
| `/rivals player [public]` | Nemeses (most MMR lost to), favourite victims (most MMR won from), most played opponents |
| `/timezone [zone]` | Your time zone for `/stats` (suggestions show each zone's current time) |
| `/install` | Buttons to add tracklatro to your account (use it anywhere) or to a server |
| `/about` | What's tracked and how many requests the bot has made |
| `/setup …` | Server channels: widgets, results, role picker, win-streak pings (see below) |

If someone queues and gets matched between two polls, people subscribed only to **queue** still get
the "match found" message, because from their point of view that player did queue.

## Live updates

On top of polling, the bot keeps two kinds of push streams open to the site (the same ones its own
pages use):

- **Followed players** (`LIVE_STREAMS`, the 50 most followed by default) each get a stream of their
  state, so subscribers' queue and match DMs go out the moment the site knows, at any speed setting.
- **One "something happened" stream** fires whenever a match starts or ends anywhere. The bot then polls
  right away, but never closer together than the speed setting's interval, so it speeds up detection
  without raising the request rate. Its counts are reused for the forecasts, and rises in the running
  match count are counted as ranked matches started per hour for the activity widget.

Queue joins of players nobody follows still rely on polling, since the trigger doesn't fire for those.
Streams reconnect by themselves, and reconnect if they go silent for 10 minutes.

**Player search:** `/stats`, `/subscribe` and the other player options autocomplete any ranked player
through the site's own search, not just tracked ones. Results are cached, and a longer query reuses a
complete shorter one.

## Stats (`/stats`)

`/stats player` shows a player's **standard ranked** games over **all seasons**. Other modes
(legacy, smallworld, casual, …) aren't counted.

- **Season standing:** rank of total and **top X%** this season.
- **Record and win rate.**
- **Nemesis and favourite victim:** the opponent they lost the most MMR to and the one they won the
  most from (3+ games against them). `/rivals` shows the top 5 of each, plus most played opponents.
- **Average game length.** The site's history has no game length, so this only covers ranked games
  the bot watched from start to end, and says how many.
- **MMR per game by time of day,** as a chart image: gains in green and losses in red, the current
  hour highlighted. Opacity shows how much they play at that hour, relative to their busiest hour:
  solid at the busiest one, mostly transparent where they hardly play. It uses MMR rather than win rate
  because MMR change accounts for opponent strength: beating someone far below you barely counts.
  Times are in the viewer's time zone. Discord doesn't tell bots a user's time zone, so users set it
  once: `/stats` shows a **"what time is it for you?"** picker (the current time in each zone, one
  click, and the stats redraw in their time), or use `/timezone`. Until then it's `STATS_TIMEZONE`.
  A raw per-hour average is mostly noise: one big game can dominate a slot. So each hour pools its
  neighbours (± 1 h, wrapping around midnight) and is shrunk toward the player's overall average by
  10 virtual games: `(sum + 10 × avg) / (games + 10)`. Hours with fewer than 5 pooled games get a dot.
  The summary line gives the best and worst hour and the current one.
  The chart is drawn as SVG and rendered to PNG on the bot itself (`@resvg/resvg-js`), in Balatro's
  pixel font [m6x11](https://managore.itch.io/m6x11) by Daniel Linssen, which is bundled.
- **Decks and stakes, best to worst,** without Cocktail Deck and without Red, Orange and Blue Stake,
  with win rate and game count. They're ranked by the
  same shrunk win rate, so a deck won once doesn't outrank one at 75% over a hundred games.
- **You vs them:** your record against that player, if you play ranked.

**Data.** Ranked results the bot sees are stored as they happen, with game length. The first `/stats`
for a player fetches their complete history in one request (`history.user_games`), which takes a
moment and says so. Later calls top up the current season's newest games since the last sync, so
downtime gets filled in. A season that ended while the bot was down is caught up once, and after
more than 14 days without a sync the full history is fetched again.

## Server channels (`/setup`)

Server admins (**Manage Server**) can give features their own channels. These are added on top of the
DMs and the live feed, and saved in the database:

| Command | |
| --- | --- |
| `/setup matches #channel` | A self-updating list of ongoing matches |
| `/setup queue #channel` | A self-updating list of players in queue |
| `/setup results #channel` | Finished matches with their results (cancelled ones aren't posted) |
| `/setup roles #channel [streak_role] [tilt_role]` | A role picker with a button per alert role (🔥 **Win-streak alerts**, 😤 **Tilt-queue alerts**) |
| `/setup streak #channel [min_streak]` | Pings the streak role when someone on a 5+ (or `min_streak`) win streak queues |
| `/setup tilt #channel [min_losses] [window_minutes]` | Pings tilt roles when someone loses 2+ games back to back, requeuing within 10 min each time |
| `/setup tilt-roles add @role [min_mmr] [max_mmr]` · `remove @role` | A tilt role for an MMR range (leave out either end for an open range: `min_mmr:1200` = 1200+) |
| `/setup activity #channel` | Ranked activity: matches started in the last hour/day/week/month, and a chart of when the queue is busiest |
| `/setup meta #channel` | Charts of the most picked decks and stakes this ranked season |
| `/setup speed <eco\|normal\|fast>` | How often to poll (see below) |
| `/setup disable <feature>` · `/setup show` | Turn a feature off · see what's set up |

- **Widgets** are one message each, edited in place when their content changes (at most every 10 s).
  Times are Discord timestamps, so they tick on their own. If a widget message is deleted, it's posted
  again. Footers show the queue's overall totals from `playerState.getActiveMatches`, refreshed at most
  once a minute.
- **Streaks** come from the leaderboard (positive = wins in a row, negative = losses in a row, like the
  queue bot) and are updated with every result the bot sees. Each streak pings once: requeuing after a
  cancel doesn't ping again, a longer streak does.
- **Tilt queues:** `min_losses`+ losses in a row where every step was quick: they requeued within
  `window_minutes` of each loss, into the next loss and then into this queue. It's built from the
  games the bot saw, so a game it missed can't sneak in (a whole game doesn't fit in a quick gap). A
  requeue is often seen before the losing result is known, so the bot checks again when that result
  comes in. Each losing chain pings once.
- **Tilt roles by MMR:** each tilt role can cover a range (inclusive, either end open). A tilt queue
  sends **one** message to the tilt channel, mentioning every role whose range holds the player's
  MMR, so overlapping ranges don't duplicate. If no range matches, nothing is posted. The role picker
  gets a button per tilt role (*Tilt: 900–1100*, *Tilt: 1200+*, …). A tilt role set up before ranges
  existed keeps working as the all-MMR one.
- **The role** must be below the bot's own role, and **mentionable** (or give the bot **Mention
  Everyone**) for pings to notify people. `/setup` warns about both.
- Like the feed, results and widgets cover the tracked players: the top `TOP_N` plus anyone followed.
- **Activity widget:** ranked matches started, counted live from the trigger stream (exact, ranked only,
  no extra requests) since the bot started counting, plus a busiest-hours chart in `STATS_TIMEZONE`.
  Hours the bot wasn't running aren't counted as quiet. The site's own `history.games_per_hour` would
  be the obvious source, but it counts every mode and currently fails (`500: Botlatro API error`).
- **Meta widget:** deck and stake pick-rate charts with their card art and stake chips, from the site's
  `stats.deck_popularity` / `stake_popularity` (ranked, current season). Those currently fail on the
  site too, so it falls back to the ranked matches the bot knows of this season and says so. It tries
  the site again every 6 hours.
- **Speed** applies right away and is kept across restarts:

  | Speed | Active / idle players polled every | Queue noticed after | Site requests/h (busy / quiet) |
  | --- | --- | --- | --- |
  | `eco` | 20 s / 60 s | ~10–60 s | ~180 / ~60 |
  | `normal` | `HOT_POLL_SECONDS` / `WARM_POLL_SECONDS` (10 s / 30 s) | ~5–30 s | ~360 / ~120 |
  | `fast` | 5 s / 10 s | ~3–10 s | ~720 / ~360 |

  An idle top player is in the warm tier, so the idle interval decides how quickly their queue is
  noticed. With the top 100, one request carries everyone, so the cost is about one request per tick.

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
defaults are the live "Standard Ranked" values shared in the BMP Discord (Oct 2026):

- **Instaqueue** at **895+** and at **400 and below** (`MM_INSTAQUEUE=895-99999,0-400`). Two players in
  the same band match instantly. Staff move the high band to roughly the **top 125** of the
  leaderboard, so update it in `.env` if it changes.
- Otherwise players match within **200 MMR** (`MM_SEARCH_START=200`), plus a range that grows the
  longer they wait.

How fast that range grows isn't public. If `MM_SEARCH_INCREMENT` isn't set, the bot **calibrates** it
from matches it watches happen. Each pairing where both queue joins were seen gives a lower bound
(`increment > (gap − 200) / ticks waited`), and the bot uses the 75th percentile once it has 15 samples.
`/about` shows the current model.

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
| `src/server.ts` | `/setup`: widgets, results channel, role picker, win-streak pings |
| `src/stats.ts` | `/stats`: stored ranked games, history sync, stats, MMR by time of day |
| `src/charts.ts` | Chart images (SVG → PNG) |
| `src/streams.ts` | Push streams from the site (tRPC subscriptions over server-sent events) |
| `src/live.ts` | Live updates: per-player streams, the "something happened" trigger, activity counting |
| `src/widgets.ts` | Widget and alert content (pure, tested) |
| `src/queue-posts.ts` | 🟢/🟡/⚪ coloring of "queued" posts |
