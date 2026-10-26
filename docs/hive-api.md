# The Hive (Bedrock) Public API — Reference

Research notes for **Mossad Tracker**. Everything below was verified live against
`https://api.playhive.com` on **2026-08-20** (unless marked *unverified*).

Machine-readable spec: [`hive-openapi.json`](./hive-openapi.json) (OpenAPI 3.1, pulled from
`https://api.playhive.com/v3/api-docs`).

---

## 1. Ground rules (official)

Source: <https://support.playhive.com/api/> and <https://api-updates.playhive.com/>

- Public API, **no warranty**. Hive reserves the right to change, take down or restrict any
  functionality at any time, for any reason.
- Automated rate limiting is applied; the reset time is in the `Retry-After` header.
- **You may not link to API-based creations on the Hive forums or Discord.** Tools that breach
  player privacy/safety get their API access restricted.
- API changes are announced on <https://api-updates.playhive.com/> (has `feed.xml` / `feed.json` —
  worth polling if we want to be notified of breaking changes).

### Recent history (matters for us)

| Date | Change |
|---|---|
| 2026-07 | Backend rewritten (PHP app → new infra). `v0` responses stay backward-compatible. Responses are faster. Header `x-hive-api-backend: rewrite` marks the new stack. |
| 2026-07-23 | **New anonymous limit: 3 requests per (player, game) per 60 min.** |
| 2026-07-23 | Hot Drops (limited edition) metadata on cosmetics: `edition`, `editional_total`. |
| 2026-08-05 | `player_number` added to the `main` profile (sequential unique join number). |
| 2026-08-07 | Better `stat_track` hub-title resolution, aligned with in-game display. |

### v2 API — not usable today

`/v2/*` exists in the spec but every call returns:

```json
{"type":"https://api.playhive.com/problems/unauthorized","title":"Authentication required",
 "status":401,"code":"unauthorized","detail":"A valid API key is required for the v2 API."}
```

Hive states they are **not accepting API key requests until v2 launches**, and no communication
about v2/auth is expected before the public release of SkyBlock Horizons. So:

> **Mossad Tracker must be designed on anonymous `v0`**, with a clean abstraction layer so that
> swapping in `v2` + Basic auth later is a one-file change.

---

## 2. Base URL, formats, transport

- Base: `https://api.playhive.com`
- No auth needed for `v0` (Basic auth is accepted and ignored when the key is invalid — it does not
  error). Authenticated keys are documented to return *additional fields*.
- All responses are JSON. Timestamps are **Unix seconds** (`first_played`), except v2 DTOs which use
  ISO strings.
- **CORS is open**: `access-control-allow-origin: *` → a browser/renderer frontend can call the API
  directly, no proxy needed.
- Behind Cloudflare (`cf-cache-status: DYNAMIC`, so no edge caching to rely on).
- Errors: `{"message":""}` with HTTP 404 for unknown player/game; `422` with a validation body for
  bad input; `429` with `{"message":"Too Many Attempts (game and player combination)."}`.

---

## 3. Rate limits (measured, not just documented)

Two independent limiters:

### 3.1 Global, per IP

```
x-ratelimit-limit: 120
x-ratelimit-remaining: 118
```

120 requests per rolling window (per-minute, consistent with observations). Present on every
response — always read it.

### 3.2 Per (player, game) combination — the important one

**3 requests per 60 minutes, anonymous.** The 4th returns:

```
HTTP/1.1 429
retry-after: 3598
{"message":"Too Many Attempts (game and player combination)."}
```

Window semantics, measured with a 60-minute probe (3 requests, then one attempt every 30 s):

- The block lifted at **exactly 3600 s after the first request** of the window (`retry-after` counted
  down 1:1 the whole way, from 3596 to 0).
- **Rejected attempts do not extend the block.** 118 consecutive 429s during that hour did not push
  the reset back by a single second — a client that misjudges the quota is not further penalised.
- Once reopened, three requests 30 s apart all returned 200.
- *Still undetermined*: fixed vs sliding window. In the probe all 3 burns happened within 3 s of each
  other, so both models predict the same outcome. To settle it, space the 3 burns 20 min apart and
  check whether 1 or 3 slots open at T+60 min of the first. It does not matter for a client that
  spaces its requests ≥20 min apart, which is safe under either model.

Measured semantics:

| Question | Answer (tested) |
|---|---|
| Does username vs UUID share the bucket? | **Yes** — same bucket (identity is resolved first). |
| Is `all/all/{player}` its own bucket? | **Yes** — burning `all/all` still leaves `all/sky` and `all/main` usable. |
| Is `all/main/{player}` separate? | Yes, `main` is just another game key. |
| Is `monthly/player/{game}/{player}` a separate bucket? | **No** — it shares the bucket of `all/{game}/{player}`. The bucket key is (player, game), across all player-scoped endpoints. |
| Are leaderboards limited? | **No** per-combination limit — `/v0/game/all/{game}`, `/v0/game/leaderboard/{game}`, `/v0/game/monthly/...` can be hammered up to the global 120/min. |
| Is `/v0/global/statistics` limited? | No per-combination limit. |
| Is `/v0/player/search/{partial}` limited? | No per-combination limit observed. |

### 3.3 Design consequences for Mossad Tracker

1. **One refresh = one `GET /v0/game/all/all/{player}`** (returns every game at once). That gives us
   3 refreshes/hour/player max → an effective **minimum polling interval of 20 minutes** per tracked
   player. Never call per-game endpoints in a loop for the same player.
2. Persist every snapshot locally (SQLite/JSON). All "session / delta / progress" features must be
   computed from our own history, not from repeated API calls.
3. Bulk data (leaderboards, monthly boards, maps, meta, catalogue) is cheap — that is where we can be
   generous, cached with a TTL (leaderboards ~5-10 min, meta/maps/catalogue ~24 h).
4. Implement a client-side token bucket + a per-(player,game) cooldown map so we never emit a request
   that we know will 429. Honour `Retry-After` and `x-ratelimit-remaining`.
5. `429` on a combination lasts a full hour — treat it as "serve from cache", not as an error to show
   the user.

---

## 4. Games

Game IDs used everywhere in `v0` (verified against `/v0/game/meta/{game}` and
`/v0/global/statistics`):

| ID | Name | Short | Max level | Prestige | Maps EP | Seasons |
|---|---|---|---|---|---|---|
| `wars` | TreasureWars | WARS | 100 | yes, max 5 | yes | no |
| `sky` | SkyWars | SKY | 100 | yes, max 5 | yes | no |
| `murder` | MurderMystery | MURDER | 100 | yes, max 5 | yes | no |
| `bed` | BedWars | BED | 100 | yes, max 1 | yes | **yes** |
| `hide` | HideAndSeek | HIDE | 100 | no | yes | no |
| `dr` | DeathRun | DR | 75 | no | yes | no |
| `sg` | SurvivalGames | SG | 50 | no | yes | no |
| `ctf` | Capture The Flag | CTF | 50 | no | yes | no |
| `build` | Build Battle | BUILD | 30 | no | yes | no |
| `drop` | Block Drop | DROP | 25 | no | yes | no |
| `grav` | Gravity | GRAV | 25 | no | yes | no |
| `party` | BlockParty | PARTY | 25 | no | **no** | no |
| `ground` | GroundWars | GROUND | 20 | no | yes | no |
| `bridge` | The Bridge | BRIDGE | 20 | no | yes | no |
| `main` | (hub / account profile) | — | — | — | no | no |
| `parkour` | Hub parkour | — | — | — | no | no |
| `sky-classic` | SkyWars Classic mode | — | — | — | no | no |
| `sky-kits` | SkyWars Kits mode | — | — | — | no | no |

`main`, `parkour`, `sky-classic`, `sky-kits` appear in `all/all` payloads but have **no**
`/v0/game/meta/*` and no `/v0/game/map/*`.

Seasons: only `bed` responds `200` on `/v0/game/season/bed/{n}`. Invalid or future season numbers return
an **empty array with 200**, not a 404 — check for `[]`, don't rely on status.

---

## 5. Endpoints (v0 — the usable API)

### 5.1 Player stats

```
GET /v0/game/all/all/{identifier}      # every game, one call  ← main call for the tracker
GET /v0/game/all/main/{identifier}     # account profile only, wrapped: {"main": {...}}
GET /v0/game/all/{game}/{identifier}   # one game, flat object
```

`{identifier}` = username (case-insensitive) **or** UUID. Unknown player → `404 {"message":""}`.

Optional headers (all opt-in, default off):

| Header | Effect |
|---|---|
| `X-Hive-Resolve-Stat-Track: true` | Resolves stat-track hub titles. `equipped_hub_title` changes from `"&9 (?) Total Kills"` (string) to `{"display":"&9 178.2K Total Kills","special_type":"combined_stat_track"}` (**object — shape change, guard your parser**). |
| `X-Hive-Resolve-Dynamic-Hub-Titles: true` | Resolves dynamic hub titles (fallback when stat-track resolution is off). |
| `X-Hive-Api-Version: <n>` | Cosmetic/hub-title resolution version, default `none`. |
| `X-Hive-Variable-Entitlements: true` | Adds a `variable_entitlements` key (main profile only). |

**Per-game stat fields** (observed; `xp`, `played`, `victories`, `first_played`, `UUID` are common to
all game blocks; `prestige` only where prestige exists):

| Game | Extra fields |
|---|---|
| `wars` | `final_kills`, `kills`, `treasure_destroyed`, `deaths`, `prestige` |
| `sky` | `kills`, `deaths`, `final_kills`, `mystery_chests_destroyed`, `ores_mined`, `spells_used`, `prestige` |
| `bed` | `final_kills`, `kills`, `beds_destroyed`, `deaths`, `prestige` |
| `murder` | `deaths`, `coins`, `murders`, `murderer_eliminations`, `bux`, `prestige` |
| `hide` | `deaths`, `hider_kills`, `seeker_kills` |
| `dr` | `deaths`, `checkpoints`, `activated`, `kills` |
| `sg` | `kills`, `deaths`, `crates`, `deathmatches`, `cows`, `teleporters_used`, `launchpads_used`, `flares_used` |
| `ctf` | `kills`, `deaths`, `assists`, `flags_captured`, `flags_returned` |
| `drop` | `blocks_destroyed`, `powerups_collected`, `vaults_used`, `deaths` |
| `ground` | `kills`, `deaths`, `blocks_destroyed`, `blocks_placed`, `projectiles_fired` |
| `build` | `rating_good_received`, `rating_love_received`, `rating_meh_received`, `rating_okay_received`, `rating_great_received` |
| `party` | `powerups_collected`, `rounds_survived` |
| `bridge` | `kills`, `deaths`, `goals` |
| `grav` | `deaths`, `maps_completed`, `maps_completed_without_dying` |
| `sky-classic` / `sky-kits` | `kills`, `deaths`, `selected_kit` (+ SkyWars extras on `sky-kits`). ⚠ `xp` here mirrors the parent `sky` XP, it is **not** mode-specific. |
| `parkour` | Nested: `parkours[world][course] = { best_run_time, best_checkpoint_times{"x,y,z":ms}, collected_stars[], course_stars }`, plus `parkours[world].parkour_stars` and `total_stars`. Times are in **ticks/centi-units** — needs calibration against in-game display. |

**`main` profile fields**:

```
UUID, xuid, mcid, username, username_cc, rank, paid_ranks[], first_played,
daily_login_streak, longest_daily_login_streak, player_number, friend_count, quest_count,
hub_title_count, hub_title_unlocked[],  equipped_hub_title,
avatar_count,   avatar_unlocked[{url,name}], equipped_avatar{url,name},
costume_count,  costume_unlocked[],
hat_count,      hat_unlocked[{name,icon,rarity}],
backbling_count, "cosmetics.backbling"[{name,icon,rarity}],   // note the literal dotted key
pets[], mounts[]
```

- `rank`: e.g. `ULTIMATE`; `paid_ranks`: `["PLUS","ULTIMATE"]`.
- Hub titles carry Minecraft `&`-colour codes → we need a formatter (`&a`, `&6`, …).
- Hot Drops cosmetics carry `edition` / `editional_total` (unverified — no sample found yet).
- Cosmetic images live on `https://cdn.playhive.com/...` (avatars, hats, backblings, maps).

### 5.2 Player search

```
GET /v0/player/search/{partial}     # partial >= 4 chars, else 422
→ [{ "UUID": "...", "username": "lizqfx", "username_cc": null }, ...]
```

`username` is lowercase-normalized; `username_cc` is the cased version (often `null` here — the real
casing comes from the `main` profile).

### 5.3 Player activity

```
GET /v0/player/activity/{id}?realtime=<bool>
→ [] (empty for the players tested — likely gated/limited)
```

### 5.4 Global counters

```
GET /v0/global/statistics
→ {"unique_players":{"global":130778156,"hide":...,"main":...,"dr":...,...}}
```

Cheap and unlimited → good for a "network" panel and for a cumulative growth chart if we snapshot it.

### 5.5 All-time leaderboards

```
GET /v0/game/all/{game}          # top 100, full stat rows
GET /v0/game/leaderboard/{game}  # same shape
```

Rows add `index` (0-based) and `human_index` (1-based) to the stat fields. **No pagination** on
all-time boards — top 100 only.

### 5.6 Monthly leaderboards

```
GET /v0/game/monthly/{game}/available            # list of available months + resource path
GET /v0/game/monthly/{game}/{year}/{month}
GET /v0/game/monthly/{game}/{year}/{month}/{amount}/{skip}     # paginated
GET /v0/game/monthly/player/{game}/{player}                    # current month, that player
GET /v0/game/monthly/player/{game}/{player}/{year}/{month}
GET /v1/game/{game}/monthly[/{year}/{month}[/{amount}/{skip}]] # v1 aliases
```

- Header `X-Hive-Show-Counts: true` on `/available` adds `entries` (total ranked players that month).
- ⚠ `GET /v0/game/monthly/{game}` (current month, no date) returns **`[]`** — including with
  `X-Hive-Leaderboard-Source: modern`. **Always pass the explicit `{year}/{month}`**; the current
  month works that way (verified for 2026/8).
- Monthly rows carry `uncapped_xp` in addition to the capped `xp`.
- `monthly/player` consumes the **same** (player, game) bucket as `all/{game}/{player}` — verified: burning one 429s the other.

### 5.7 Seasons

```
GET /v0/game/season/{game}/{season}[/{amount}/{skip}]
GET /v0/game/season/player/{game}/{player}/{season}[/{amount}/{skip}]
GET /v0/game/special/wars/rewards[/{amount}/{skip}]     # TreasureWars all-time rewards board
```

Only `bed` returns data today. Out-of-range seasons → `200 []`.

### 5.8 Metadata / static content

```
GET /v0/game/meta/{game}   # name, shortName, maxLevel, allowPrestiging, maxPrestige,
                           # experienceToLevel { "<xpThreshold>": <level>, ... }
GET /v0/game/map/{game}    # [{ name, season, variant, image }]
GET /v0/catalogue/titles       /v0/catalogue/titles/{id}
GET /v0/catalogue/costumes     /v0/catalogue/costumes/{id}
```

- `experienceToLevel` is the authoritative XP→level table — do **not** hardcode formulas, fetch and
  cache it per game (24 h TTL).
- Catalogue entries: `{ UUID, display, unlock_data: { type, active, metadata } }` where `type` is
  e.g. `GAME_LEVEL` (`metadata: {game, level}`), `LEGACY` (with `originalUnlockType`,
  `lastAvailable`, `description`), `SPECIAL_EVENT`, …
- `X-Hive-Leaderboard-Source: modern` selects the Postgres/Redis source on leaderboard endpoints;
  anything else uses the legacy source. It is echoed back in the response. No behavioural difference
  observed so far — leave it unset unless we hit an inconsistency.

---

## 6. v2 API (documented, locked behind a key — for future-proofing)

`basicAuth` (HTTP Basic). Endpoints, all `GET`:

```
/v2                                              discovery root
/v2/players                                      search
/v2/players/{player_id}                          profile
/v2/players/{player_id}/statistics[/{game_id}]
/v2/players/{player_id}/entitlements
/v2/players/{player_id}/cosmetics
/v2/players/{player_id}/activity
/v2/network/statistics
/v2/leaderboards[/{id}[/entries[/{player_id}]]]
/v2/games[/{game_id}[/progression|/maps]]
/v2/cosmetics[/{cosmetic_id}]
```

Notable design of v2, worth mirroring in our own internal model:

- Envelope: `{ "data": [...], "pagination": { limit, offset, cursor, next_cursor, total } }`.
- `PlayerProfileDto`: `id, username, username_normalized, external_identities, rank, paid_ranks[],
  first_joined_at, player_number, login_streak, friend_count, quest_count, links{}`.
- `PlayerStatisticsDto`: `player_id, game_id, first_played_at, statistics{}` (free-form map).
- `GameDto` exposes a `stat_schema: [{key, type}]` → a **self-describing** stat list. Our UI should
  be data-driven so it can consume that later instead of hardcoded field tables.
- `LeaderboardDto`: `id, game_id, kind, period, season_id, event_id, status, ordered_by,
  entry_count`. Errors are RFC 7807 problem+json.

---

## 7. Practical client checklist for Mossad Tracker

- [ ] Single HTTP client with: retry/backoff, `Retry-After` handling, global 120/min token bucket,
      per-(player,game) 3/60min cooldown ledger, and an ETag-less TTL cache.
- [ ] Send a descriptive `User-Agent` (e.g. `mossadTracker/0.1`) — be identifiable and polite.
- [ ] Tracked-player refresh: `all/all/{player}` every ≥20 min; store a snapshot row per fetch.
- [ ] Deltas/sessions/rate-of-progress computed locally from the snapshot history.
- [ ] Static caches: `meta/{game}` and `map/{game}` and catalogues 24 h; leaderboards 5–10 min;
      `global/statistics` 5 min.
- [ ] Resolve usernames → UUID once and key everything internally by UUID (usernames change).
- [ ] Parse `&`-colour codes for hub titles / display strings.
- [ ] Treat `[]` as "no data" (seasons, current-month, activity), not as an error.
- [ ] Poll `https://api-updates.playhive.com/feed.json` for breaking-change announcements.
- [ ] Respect Hive's rule: **no linking/promoting the tool on Hive forums or Discord**, and don't
      expose anything that could harm player privacy.

## 8. Open questions

- Exact window of the global 120 limit (per minute assumed; no reset header exposed).
- Whether `player/activity` ever returns data anonymously, and what `?realtime=true` changes.
- `parkour` time units (ticks vs ms) — needs an in-game cross-check.
- Hot Drops `edition` / `editional_total` shape (no sample player found yet).
