# Mossad Tracker

Web tracker for **The Hive** (Minecraft Bedrock): keep a watchlist of players and know, as precisely
as the public API allows, **when they play and what they play** — plus a statistics view per game.

The Hive exposes no online/presence endpoint, so activity is inferred from counter deltas: when a
player's `played` counter for SkyWars moves between two observations, they finished matches in that
window. Everything else — sessions, habits, "live" status — is derived from our own history.

## Quick start

On Windows, double-click **mossadTracker.bat**: it builds on first run, starts the tracker and opens
the page in your default browser once the server actually answers. Closing the window stops it.
Run `mossadTracker.bat rebuild` to force a fresh build after changing the code.

```bash
npm install
npm run dev
```

- Web UI: <http://localhost:5273>
- API: <http://localhost:3717>

Production: `npm run build` then `npm start` (the API serves `dist/web` and the tracker on the same
port, `API_PORT` or `PORT`, default 3717).

```bash
npm test
```

Covers the delta → event → session pipeline and the XP/level curve — the two places where a wrong
answer looks plausible instead of crashing.

## The two views

- **Snipe** — the watchlist: who is playing right now, what mode, how long ago, and a countdown to
  the next check. This is the activity tracker.
- **Statistics** — a per-game stat card (wins, losses, win rate, K/D, final kills, level progress),
  scoped to all-time, this month, this week or today.

## How it works

| Piece | File |
|---|---|
| Rate-limit ledger (3 req / player / game / hour, 120 req/min global) | `src/server/hive/limiter.ts` |
| Hive HTTP client | `src/server/hive/client.ts` |
| Poll scheduler (bucket rotation + adaptive tiers) | `src/server/tracker/scheduler.ts` |
| Delta → activity event → session pipeline | `src/server/tracker/ingest.ts` |
| Monthly history rebuilt from leaderboards | `src/server/tracker/backfill.ts` |
| Discord alerts on session start | `src/server/notifier.ts` |
| Retention and derived-data rebuilds | `src/server/maintenance.ts` |
| Level/XP curve from game metadata | `src/server/hive/meta.ts` |
| Read models for the UI | `src/server/queries.ts`, `src/server/stats.ts` |
| REST + SSE | `src/server/index.ts` |
| React UI | `src/web/` |

The scheduler rotates between three independent rate-limit buckets per player (`all`, `main`, and the
game they are currently on), each worth 3 requests/hour, which yields **one observation every ~7
minutes** for an active player without ever hitting a 429. Cold players fall back to one `all` fetch
every 20 min, dormant ones to hourly.

## Look

The interface uses the same design system as **NinjaStats** (`F:\site`), so the two surfaces read as
one product: the tokens at the top of [`src/web/index.css`](src/web/index.css) — colours, radii,
easing, the violet→cyan→pink gradient — are copied from `assets/css/style.css` there, along with the
glass surfaces, the KPI tiles, the game chips and the drifting aurora background.

Inter and JetBrains Mono are self-hosted in `src/web/public/fonts`, like on the static site: no
third-party request, and the app works offline. There is no component library — the few primitives
we need (`.glass`, `.btn`, `.chip`, `.gchip`, `.pill`, `.kpi`, `.mode`, `.tile`) are plain CSS.

## Storage and retention

SQLite (`data/tracker.db`). Raw API payloads live in `snapshots` for **7 days**, long enough to
recompute a new metric retroactively without spending quota; the counters, events, sessions and
monthly history derived from them are kept indefinitely. Without that cap the raw payloads grow by
roughly 18 MB a day for 13 players.

## Alerts

The Discord bot (below) posts when a tracked player **starts** a session — not on every detection. Individual players can be muted from their own page.
The message states the uncertainty window rather than pretending to a precise timestamp.

## Discord bot

Manages the watchlist from Discord and posts an embed when a tracked player starts playing on Hive.
It runs **inside the API process** — a separate process would open the same SQLite file and the two
would block each other — and calls the same service functions as the HTTP routes, so both stay
consistent.

```
/track player:<gamertag>              start tracking someone (suggestions from Hive search)
/untrack player:<tracked player>      stop tracking and delete their history
/alerts player:<tracked player> on|off   mute or unmute their alerts
/watchlist [group:]                   show the watchlist with live status
/online                               who is in a session right now
/stats player: game: [period:]        stat card for one game
/sessions player:                     last sessions, usual hours, who they play with
/compare player1: player2: [game:]    two players side by side
/report [period:]                     most active, longest session, level-ups
/link code: · /unlink                 link a website account (its permissions apply in Discord)
```

Alerts (each switchable in the *Discord bot* panel): online, session summary, milestones (5th
levels, prestige, win streaks), inactivity, daily and weekly reports. Groups can route their alerts
to their own channel. Every change to the watchlist, from either side, lands in the **Audit** page.

`/track` suggests Hive players from 4 typed characters (cached, and skipped when the scheduler needs
the global budget); `/untrack` and `/alerts` suggest from the local watchlist without calling Hive.
Who may change the watchlist comes from the website account linked with `/link` (Tracker = all,
Tracker user = `/track` up to its limit); members who never linked need *Manage Server*.

**Online alerts.** When a tracked player starts a Hive session, the bot posts an embed (game,
matches, detection window in each reader's timezone) in `DISCORD_ALERT_CHANNEL_ID`, or in
`DISCORD_CHANNEL_ID` if only that one is set. It honours the per-player mute.

The old `.addTracker` text commands still exist behind `DISCORD_PREFIX`, off by default because they
need the privileged MESSAGE CONTENT intent. No token means the bot simply never starts.

Setup, step by step — developer portal, invite link, channels, permissions, troubleshooting:
[`docs/discord-bot.md`](docs/discord-bot.md).

## In-game link

A headless feature of the Oriel client reports tracked players standing in the same Hive lobby as
you. A sighting is a direct observation, so it enters the history as a zero-width event: the
player's status becomes exact instead of estimated. Setup and limits:
[`docs/in-game-link.md`](docs/in-game-link.md).

## Rebuilding history

Monthly leaderboards carry no per-player rate limit, and one page covers the top 100 at once, so
months of history can be rebuilt for every tracked player in a few dozen requests:

```bash
curl -X POST localhost:3717/api/backfill -H "Content-Type: application/json" -d "{\"months\":6}"
```

It also runs by itself, at most once a day. A player outside the top 100 has no row for that month —
the UI shows that as missing data, never as "did not play".

## Documentation

- [`docs/hive-api.md`](docs/hive-api.md) — full API reference with the **measured** rate limits, all
  game IDs and stat fields, and the v2/API-key situation.
- [`docs/in-game-link.md`](docs/in-game-link.md) — the in-game client: what a sighting proves,
  how to set it up, what it cannot see.
- [`docs/tracking-design.md`](docs/tracking-design.md) — why the design looks like this, what the
  detection can and cannot see.
- [`docs/hive-openapi.json`](docs/hive-openapi.json) — upstream OpenAPI spec (snapshot).

## Dev tools

```bash
node --disable-warning=ExperimentalWarning scripts/simulate-activity.ts <player> [game] [matches]
```

Replays a synthetic observation through the real ingest pipeline — useful to exercise the
delta → event → session chain without burning API quota. The next real fetch re-baselines the faked
counters automatically.

## Limits, honestly

- Resolution is ~7 min at best, 20 min for a cold player. A match in progress is invisible until it
  ends.
- A player who logs in without finishing a match may only show up through `quest_count`.
- SkyWars Classic and SkyWars Kits were retired by Hive; their blocks still echo SkyWars XP, so they
  are ignored on ingest.
- Hive's terms: the API comes with no warranty, and **tools built on it must not be linked or
  promoted on Hive's forums or Discord**.
