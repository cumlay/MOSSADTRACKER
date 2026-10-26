# Mossad Tracker — Activity Tracking Design

Goal: **know as precisely as possible when a given player is playing on The Hive**, from a watchlist
of players, using only the public `v0` API.

Companion document: [`hive-api.md`](./hive-api.md) (API reference + measured rate limits).

---

## 1. The core problem

The Hive exposes **no presence/online endpoint**. `/v0/player/activity/{id}` returns `[]` for every
player tested, with or without `?realtime=true`. So presence has to be **inferred from counter
deltas**: if `sky.played` went from 412 to 414 between two observations, the player finished 2
SkyWars matches inside that window.

Consequences:

- Detection is **interval-based**, never instantaneous. We learn "played between T₁ and T₂", not
  "played at T".
- Counters only move when a **match ends**, so there is an intrinsic lag of one match length
  (~2–10 min depending on the game).
- Our accuracy ceiling = our sampling rate. Which is capped by the rate limiter.

## 2. The rate limit is the whole design

Measured (see `hive-api.md` §3): **3 requests per (player, game) bucket per 60 minutes**, anonymous.
`retry-after` decays 1:1 with wall-clock time from ~3600s, i.e. the window is one hour anchored on the
**first** request of the window. `monthly/player/{game}/{player}` shares the bucket of
`all/{game}/{player}` — the key is really (player, game) across all player-scoped endpoints.

But **each game is its own bucket**, and the pseudo-games `all` and `main` are buckets too. That is
the exploit that makes a 10-minute tracker possible:

| Bucket | Endpoint | What it tells us | Budget |
|---|---|---|---|
| `all` | `/v0/game/all/all/{p}` | every game's counters at once | 3/h |
| `main` | `/v0/game/all/main/{p}` | `quest_count`, `daily_login_streak`, cosmetics, friends | 3/h |
| `<game>` | `/v0/game/all/{game}/{p}` | one game's counters | 3/h **each**, 14+ games |

### Sustainable cadence

A steady **1 request / 20 min per bucket** is safe under both a fixed and a sliding window
interpretation. Interleaving three buckets:

```
:00   all/all      → full picture, every game
:07   all/main     → "did anything happen at all" (quest_count moves during play)
:13   all/<hot>    → the game they are currently playing
:20   all/all
...
```

→ **an observation every ~6–7 minutes** per tracked player, **9 requests/hour/player**.

The rotation is produced by two gates rather than by pinning each bucket to a fixed slot of the
cycle:

- **per bucket**: the ledger (20 min spacing + the 3/hour quota);
- **per player**: never two observations closer than `interval / bucket count` (~6.7 min), so
  observations stay spread instead of clumping.

Among the buckets that pass both gates, the least recently fetched one wins. This self-synchronises
into the clean rotation above and, unlike fixed slots, recovers immediately from any hiccup. The
first implementation *did* pin buckets to slots, and a bucket whose ledger gate opened just after its
slot had to wait a whole extra cycle — which showed up in production as 23-minute detection windows
where 20 was expected.

Global limit is 120 req/min (7 200/h) per IP, so the binding constraint is per-player, not global:
~700 actively-tracked players before the global bucket matters. We are nowhere near that.

### Adaptive tiers

| Tier | Condition | Schedule | Cost |
|---|---|---|---|
| `hot` | activity detected in the last 30 min | `all` + `main` + hot game, interleaved (~7 min resolution) | 9/h |
| `warm` | played in the last 24 h | `all` + `main` interleaved (~10 min resolution) | 6/h |
| `cold` | nothing for 24 h+ | `all` every 20 min (~20 min resolution) | 3/h |
| `dormant` | nothing for 14 days | `all` every 60 min | 1/h |

Tiers are re-evaluated after every fetch. A cold player who shows a delta is promoted to `hot`
immediately and the hot-game bucket starts being polled on the next tick.

### The rate-limit ledger

Every request is recorded in `fetch_log` with its bucket key. Before any fetch, the scheduler checks
the ledger: *have I made 3 requests to this bucket in the last 60 min?* If yes, the fetch is skipped
(never attempted). A real `429` still gets caught and its `retry-after` written into a cooldown table
as a hard block — treat it as "serve cache", not as an error.

## 3. What we compute from the deltas

For each pair of consecutive observations of a game (t_prev, t_now):

- `Δplayed > 0` → an **activity event**: `{player, game, window_start, window_end, matches, deltas}`.
- The event's *point estimate* of when they played is the window midpoint; the window itself is kept
  so the UI can show real uncertainty (`played between 14:03 and 14:10`).
- `main.quest_count` increasing without any `played` delta → activity, game unknown (they are online,
  in a match that has not ended yet, or in a game we have not sampled). Useful for the "online now"
  signal because quests tick during play.
- `daily_login_streak` increasing → they logged in at least once today (coarse daily confirmation).

### Derived state per player

```
status        = live | recent | today | idle | stale
last_game     = last game with a positive Δplayed
last_seen_at  = end of the most recent activity window
confidence    = width of that window (how sure we are)
```

- **live**: activity in the most recent completed window (< ~15 min old).
- **recent**: < 1 h. **today**: < 24 h. **idle**: < 7 d. **stale**: beyond.

### Sessions

Activity events for a player are merged into a session when the gap between them is < 30 min. A
session stores: start, end, games played, matches, win/loss and kill deltas. This is what answers
"when does this person play" over time.

The gap is measured between the **end** of the new detection and the end of the running session, not
between its start. A detection window stretches back to the previous observation, so when polling is
interrupted — the tracker was down, say — its start can sit right against the previous session and
glue hours of silence into one session that never happened. Sessions are pure derived data, so
`rebuildSessions()` in `maintenance.ts` regenerates them all whenever this rule changes.

### Retention

Raw snapshots are dropped after 7 days (`SNAPSHOT_RETENTION_MS`), pruned at boot and hourly. They
exist only to recompute derived data after a code change; at ~14 kB each and ~1 400 fetches a day
they are the only table that would otherwise grow without bound. Everything derived from them —
counters, events, sessions, monthly history — is permanent.

### Rebuilt history

Monthly leaderboards are not subject to the per-(player, game) limit and return the top 100 in one
page, so `backfill.ts` walks the last months of every game the watchlist plays and stores each
tracked player's row in `monthly_stats`. One request serves every tracked player at once, which is
what makes it affordable. Absence of a row means "outside the top 100 that month" and must never be
rendered as "did not play".

### Presence heatmap

Aggregate sessions into a 7 × 24 grid (local timezone), weighting each activity window across the
hours it spans. That gives the *habitual* play schedule of a player — the highest-value view for the
stated goal, and it gets better every day we keep polling.

## 4. Storage

SQLite (`node-sqlite3-wasm`, same as Ninja Hub — no native build on Windows).

| Table | Purpose |
|---|---|
| `players` | watchlist: uuid (PK), username, cased name, tier, enabled, added_at |
| `snapshots` | raw JSON of every `all/all` / `main` / per-game fetch, with `fetched_at` |
| `stat_points` | normalized per (player, game, observed_at): played, victories, xp, kills, deaths + extra JSON. Written only when something changed (plus one baseline). |
| `activity_events` | derived: player, game, window_start, window_end, matches, delta JSON |
| `sessions` | merged events: start, end, matches, games JSON |
| `fetch_log` | one row per HTTP request: bucket key, status, retry_after — powers the ledger |
| `meta_cache` | game meta / maps / catalogue, TTL 24 h |

Raw snapshots are kept so that any future metric can be recomputed retroactively without new API
calls — with 3 fetches/hour/player they cost a few MB per player per year.

## 5. Stack

- **Server**: Node 24, TypeScript (ESM), Fastify 5, `node-sqlite3-wasm`, in-process scheduler ticking
  every 15 s, SSE for pushing live updates to the UI.
- **Web**: Vite + React 18 + TypeScript + Tailwind 3 + HeroUI + TanStack Query + Recharts — identical
  to Ninja Hub so both codebases feel the same.
- Single repo, single `package.json`; Vite dev server proxies `/api` to Fastify.

## 6. Screens

1. **Dashboard** — watchlist sorted by `last_seen_at`, one row per player: status pill, last game +
   icon, "il y a 8 min", today's matches, current session length. Live-updating over SSE.
2. **Player** — timeline of sessions, 7 × 24 presence heatmap, per-game stat table with deltas over
   24 h / 7 d, raw activity event log with uncertainty windows.
3. **Add player** — `/v0/player/search/{partial}` (min 4 chars), resolves to UUID, adds to watchlist.

## 7. Known limits (be honest in the UI)

- Resolution is ~7 min at best, ~20 min for a cold player. Never claim second-level precision.
- A match in progress is invisible until it ends.
- A player who joins the hub, chats and leaves without finishing a match is invisible (except for a
  possible `quest_count` tick).
- Username changes: everything is keyed by UUID; the display name is refreshed from `main`.
- Hive rule: this tool must not be linked or promoted on Hive's forums or Discord.
