# In-game link — who is standing in your lobby

The tracker infers activity from counters that only move when a match ends, so every detection
carries a few minutes of uncertainty. The in-game client removes that uncertainty for the one case
that matters most while you are playing: a tracked player **in the lobby you are in right now**.

The client is a headless feature of [Oriel](../../../D:/Oriel) (`src/feature/TrackerLink.cpp`). It
draws nothing, writes nothing to chat and has no entry in the menu. It reads the server's own player
list — the same list the game already shows you — and reports the names that are on the watchlist.

## What it changes in the tracker

A sighting is a different kind of evidence from everything else stored here:

| | counter delta | sighting |
|---|---|---|
| What it proves | a match ended somewhere in a window | they were on this server at this instant |
| Uncertainty | ±3 to ±10 minutes | none |
| Says what they played | yes | no — standing in a lobby is not a finished match |

So a sighting is recorded as an activity event of **zero width**: the player's status becomes exact
(`live`, ± 0) instead of estimated, their `matches` count is untouched, and `last_game` stays
whatever they actually last played.

## Setting it up

**1. Give the server a token.** Any long random string; both sides must hold the same one.

```bash
openssl rand -hex 32
```

Put it in `.env` (or `/etc/corlay/tracker.env` on the server) as `CLIENT_TOKEN=…` and restart the
tracker. While it is empty, both routes below answer `404` and the link is simply off.

**2. Tell the client where to report.** Create `%LOCALAPPDATA%\Oriel\tracker.json`:

```json
{
  "url": "https://your-server.example/tracker",
  "token": "the same value as CLIENT_TOKEN",
  "reporter": "andy"
}
```

`url` is the tracker's base, without a trailing slash — the same prefix the website is served under.
`reporter` is optional and only labels the rows. Without this file, Oriel never contacts anything.

Use `https`. Over plain `http` the token travels in clear, and the client says so in `oriel.log`.

## The two routes

Both live under `/api/client/`, authenticated by `Authorization: Bearer <token>` and nothing else:
the website's nginx access headers do not apply to them, and the token grants these two routes only.

```
GET  /api/client/roster     -> { players: [{ uuid, name }], window_ms }
POST /api/client/sighting   <- { server, game, mode, reporter, players: [{ name }] }
                            -> { ok, matched, recorded, names }
```

The client reports the **whole lobby**; the server decides what is new. Reporting the same roster
every couple of seconds therefore costs one row and one Discord alert per arrival, not per report.
The same player on the same server stays quiet for 5 minutes; moving to another server is news at
once.

## What it cannot see

- Only lobbies you are in yourself. This is not a network-wide presence feed.
- Names, not UUIDs: a player who changed gamertag since being added is matched once the tracker
  refreshes their profile.
- Nothing at all when Minecraft is closed, or when Oriel is not injected.
