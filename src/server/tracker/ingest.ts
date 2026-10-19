import { config } from '../config.ts'
import { all, get, j, lastInsertId, run, unj } from '../db.ts'
import { NON_GAME_KEYS, game as gameInfo } from '../../shared/games.ts'
import type { AllPayload, GamePayload } from '../hive/client.ts'

const CORE = ['played', 'victories', 'xp', 'kills', 'deaths'] as const
type CoreKey = (typeof CORE)[number]

export interface IngestResult {
  /** Games where a counter moved during this observation. */
  changed: Array<{ game: string; matches: number; windowStart: number; windowEnd: number; delta: Record<string, number> }>
  /** True when we detected activity without knowing the game (quest_count moved). */
  unknownActivity: boolean
  /** Detections that opened a brand new session — what alerts fire on. */
  sessionStarts: Array<{ game: string; matches: number; windowStart: number; windowEnd: number }>
}

interface GameStateRow {
  last_observed_at: number
  last_changed_at: number | null
  played: number
  victories: number
  xp: number
  kills: number
  deaths: number
  extra: string
}

function numericFields(payload: GamePayload): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(payload)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
  }
  return out
}

/**
 * Compares one game payload against what we already knew.
 * Returns the activity event to record, or null when nothing moved.
 */
function observeGame(uuid: string, gameId: string, payload: GamePayload, observedAt: number) {
  const values = numericFields(payload)
  if (Object.keys(values).length === 0) return null

  const prev = get<GameStateRow>('SELECT * FROM game_state WHERE uuid = ? AND game = ?', [uuid, gameId])

  const core: Record<CoreKey, number> = {
    played: values.played ?? 0,
    victories: values.victories ?? 0,
    xp: values.xp ?? 0,
    kills: values.kills ?? 0,
    deaths: values.deaths ?? 0
  }
  const extra: Record<string, number> = {}
  for (const [k, v] of Object.entries(values)) {
    if (!(CORE as readonly string[]).includes(k)) extra[k] = v
  }

  const writeState = (changedAt: number | null) => {
    run(
      `INSERT INTO game_state (uuid, game, last_observed_at, last_changed_at, played, victories, xp, kills, deaths, extra)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(uuid, game) DO UPDATE SET
         last_observed_at = MAX(excluded.last_observed_at, game_state.last_observed_at),
         last_changed_at  = COALESCE(excluded.last_changed_at, game_state.last_changed_at),
         played = excluded.played, victories = excluded.victories, xp = excluded.xp,
         kills = excluded.kills, deaths = excluded.deaths, extra = excluded.extra`,
      [uuid, gameId, observedAt, changedAt, core.played, core.victories, core.xp, core.kills, core.deaths, j(extra)]
    )
  }

  if (!prev) {
    // Baseline: we have no idea when these counters were earned.
    writeState(null)
    run(
      'INSERT INTO stat_points (uuid, game, observed_at, played, victories, xp, kills, deaths, extra) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [uuid, gameId, observedAt, core.played, core.victories, core.xp, core.kills, core.deaths, j(extra)]
    )
    return null
  }

  const prevExtra = unj<Record<string, number>>(prev.extra, {})
  const delta: Record<string, number> = {}
  for (const k of CORE) {
    const d = core[k] - prev[k]
    if (d !== 0) delta[k] = d
  }
  for (const [k, v] of Object.entries(extra)) {
    const d = v - (prevExtra[k] ?? v)
    if (d !== 0) delta[k] = d
  }

  const moved = Object.keys(delta).length > 0
  // Negative `played` means the counter was reset (prestige, data fix): re-baseline silently.
  const reset = (delta.played ?? 0) < 0

  writeState(moved ? observedAt : null)

  if (!moved || reset) return null

  run(
    'INSERT INTO stat_points (uuid, game, observed_at, played, victories, xp, kills, deaths, extra) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [uuid, gameId, observedAt, core.played, core.victories, core.xp, core.kills, core.deaths, j(extra)]
  )

  return {
    game: gameId,
    matches: delta.played ?? 0,
    // Order-independent: an out-of-order observation must still produce a sane window.
    windowStart: Math.min(prev.last_observed_at, observedAt),
    windowEnd: Math.max(prev.last_observed_at, observedAt),
    delta
  }
}

function recordEvent(uuid: string, ev: { game: string; matches: number; windowStart: number; windowEnd: number; delta: Record<string, number> }): boolean {
  run(
    'INSERT INTO activity_events (uuid, game, window_start, window_end, matches, delta) VALUES (?, ?, ?, ?, ?, ?)',
    [uuid, ev.game, ev.windowStart, ev.windowEnd, ev.matches, j(ev.delta)]
  )
  const eventId = lastInsertId()
  return attachToSession(uuid, eventId, ev)
}

/** Merges an event into the running session, or opens a new one after a long gap. */
function attachToSession(uuid: string, eventId: number, ev: { game: string; matches: number; windowStart: number; windowEnd: number }): boolean {
  const last = get<{ id: number; started_at: number; ended_at: number; matches: number; games: string }>(
    'SELECT * FROM sessions WHERE uuid = ? ORDER BY ended_at DESC LIMIT 1',
    [uuid]
  )

  // Compared on window *end*, not start: a detection window stretches back to the
  // previous observation, so after a gap in polling its start can sit right against the
  // last session and glue hours of silence into one session that never happened.
  if (last && ev.windowEnd - last.ended_at <= config.scheduler.sessionGapMs) {
    const games = new Set(unj<string[]>(last.games, []))
    if (ev.game !== 'unknown') games.add(ev.game)
    run('UPDATE sessions SET ended_at = ?, matches = matches + ?, games = ? WHERE id = ?', [
      Math.max(last.ended_at, ev.windowEnd),
      ev.matches,
      j([...games]),
      last.id
    ])
    run('UPDATE activity_events SET session_id = ? WHERE id = ?', [last.id, eventId])
    return false
  }

  run('INSERT INTO sessions (uuid, started_at, ended_at, matches, games) VALUES (?, ?, ?, ?, ?)', [
    uuid,
    ev.windowStart,
    ev.windowEnd,
    ev.matches,
    j(ev.game === 'unknown' ? [] : [ev.game])
  ])
  run('UPDATE activity_events SET session_id = ? WHERE id = ?', [lastInsertId(), eventId])
  return true
}

/** Refreshes the denormalized columns the dashboard reads. */
export function refreshPlayerState(uuid: string, now = Date.now()): void {
  const latest = get<{ game: string; window_start: number; window_end: number }>(
    'SELECT game, window_start, window_end FROM activity_events WHERE uuid = ? ORDER BY window_end DESC LIMIT 1',
    [uuid]
  )
  const lastGame = get<{ game: string }>(
    "SELECT game FROM activity_events WHERE uuid = ? AND matches > 0 AND game != 'unknown' ORDER BY window_end DESC LIMIT 1",
    [uuid]
  )
  const lastFetch = get<{ t: number }>('SELECT MAX(last_observed_at) AS t FROM game_state WHERE uuid = ?', [uuid])

  /*
   * The *midpoint* of the last detection window, not its end.
   *
   * A window stretches from the previous observation to this one, so its end is simply
   * "when we looked", not when they played. Anchoring on the end claims they were
   * playing seconds ago even when the window is days wide — which is exactly what
   * happens after the tracker has been down. The midpoint is the honest single-point
   * estimate, and `last_seen_window_ms` carries the uncertainty around it.
   */
  const seenAt = latest ? Math.round((latest.window_start + latest.window_end) / 2) : null
  const tier = pickTier(seenAt, now)

  run(
    'UPDATE players SET last_seen_at = ?, last_seen_window_ms = ?, last_game = ?, last_fetch_at = ?, tier = ? WHERE uuid = ?',
    [
      seenAt,
      latest ? latest.window_end - latest.window_start : null,
      lastGame?.game ?? null,
      lastFetch?.t ?? null,
      tier,
      uuid
    ]
  )
}

function pickTier(lastSeenAt: number | null, now: number) {
  if (lastSeenAt === null) return 'cold'
  const age = now - lastSeenAt
  if (age <= config.scheduler.hotWindowMs) return 'hot'
  if (age <= config.scheduler.warmWindowMs) return 'warm'
  if (age >= config.scheduler.dormantAfterMs) return 'dormant'
  return 'cold'
}

/** Ingests a full `all/all` payload: every game at once. */
export function ingestAll(uuid: string, payload: AllPayload, fetchedAt: number): IngestResult {
  run('INSERT INTO snapshots (uuid, bucket, fetched_at, payload) VALUES (?, ?, ?, ?)', [uuid, 'all', fetchedAt, j(payload)])

  const changed: IngestResult['changed'] = []
  const sessionStarts: IngestResult['sessionStarts'] = []
  for (const [key, value] of Object.entries(payload)) {
    if (!value || typeof value !== 'object') continue
    if (key === 'main') {
      applyProfile(uuid, value as GamePayload)
      continue
    }
    if (NON_GAME_KEYS.has(key)) continue
    const ev = observeGame(uuid, key, value as GamePayload, fetchedAt)
    if (ev) {
      if (recordEvent(uuid, ev)) sessionStarts.push(ev)
      changed.push(ev)
    }
  }
  refreshPlayerState(uuid, fetchedAt)
  return { changed, unknownActivity: false, sessionStarts }
}

/** Ingests one game payload (the "tighten the resolution" fetch). */
export function ingestGame(uuid: string, gameId: string, payload: GamePayload, fetchedAt: number): IngestResult {
  run('INSERT INTO snapshots (uuid, bucket, fetched_at, payload) VALUES (?, ?, ?, ?)', [uuid, gameId, fetchedAt, j(payload)])
  const ev = observeGame(uuid, gameId, payload, fetchedAt)
  const started = ev ? recordEvent(uuid, ev) : false
  refreshPlayerState(uuid, fetchedAt)
  return { changed: ev ? [ev] : [], unknownActivity: false, sessionStarts: started && ev ? [ev] : [] }
}

/**
 * Ingests the `main` profile. `quest_count` ticks while a player is in a match, so a
 * bump here is activity even when no game counter moved yet — we record it as an
 * `unknown` game event so the UI can still say "online, game not identified yet".
 */
export function ingestMain(uuid: string, payload: GamePayload, fetchedAt: number): IngestResult {
  run('INSERT INTO snapshots (uuid, bucket, fetched_at, payload) VALUES (?, ?, ?, ?)', [uuid, 'main', fetchedAt, j(payload)])

  const prev = get<GameStateRow>("SELECT * FROM game_state WHERE uuid = ? AND game = 'main'", [uuid])
  applyProfile(uuid, payload)

  const quests = typeof payload.quest_count === 'number' ? payload.quest_count : 0
  const streak = typeof payload.daily_login_streak === 'number' ? payload.daily_login_streak : 0
  const prevExtra = prev ? unj<Record<string, number>>(prev.extra, {}) : {}

  run(
    `INSERT INTO game_state (uuid, game, last_observed_at, last_changed_at, played, victories, xp, kills, deaths, extra)
     VALUES (?, 'main', ?, ?, 0, 0, 0, 0, 0, ?)
     ON CONFLICT(uuid, game) DO UPDATE SET
       last_observed_at = excluded.last_observed_at,
       last_changed_at  = COALESCE(excluded.last_changed_at, game_state.last_changed_at),
       extra = excluded.extra`,
    [uuid, fetchedAt, fetchedAt, j({ quest_count: quests, daily_login_streak: streak })]
  )

  const prevQuests = prevExtra.quest_count
  const moved = prev !== undefined && typeof prevQuests === 'number' && quests > prevQuests
  if (!moved) {
    refreshPlayerState(uuid, fetchedAt)
    return { changed: [], unknownActivity: false, sessionStarts: [] }
  }

  recordEvent(uuid, {
    game: 'unknown',
    matches: 0,
    windowStart: prev.last_observed_at,
    windowEnd: fetchedAt,
    delta: { quest_count: quests - prevQuests }
  })
  refreshPlayerState(uuid, fetchedAt)
  return { changed: [], unknownActivity: true, sessionStarts: [] }
}

function applyProfile(uuid: string, main: GamePayload): void {
  const username = typeof main.username === 'string' ? main.username : null
  const cased = typeof main.username_cc === 'string' ? main.username_cc : null
  const rank = typeof main.rank === 'string' ? main.rank : null
  const firstPlayed = typeof main.first_played === 'number' ? main.first_played : null
  const playerNumber = typeof main.player_number === 'number' ? main.player_number : null

  run(
    `UPDATE players SET
       username = COALESCE(?, username),
       username_cc = COALESCE(?, username_cc),
       rank = COALESCE(?, rank),
       first_played = COALESCE(?, first_played),
       player_number = COALESCE(?, player_number),
       profile = ?
     WHERE uuid = ?`,
    [username, cased, rank, firstPlayed, playerNumber, j(main), uuid]
  )
}

/** Games this player actually plays, most recently active first — drives the "hot game" probe. */
export function hotGamesFor(uuid: string, limit = 2): string[] {
  const rows = all<{ game: string }>(
    `SELECT game FROM activity_events
     WHERE uuid = ? AND matches > 0 AND game != 'unknown'
     GROUP BY game
     ORDER BY MAX(window_end) DESC
     LIMIT ?`,
    [uuid, limit]
  )
  if (rows.length > 0) return rows.map((r) => r.game)

  // No observed activity yet: fall back to the games with the most lifetime matches.
  return all<{ game: string }>(
    `SELECT game FROM game_state WHERE uuid = ? AND played > 0 AND game NOT IN ('main', 'unknown')
     ORDER BY played DESC LIMIT ?`,
    [uuid, limit]
  ).map((r) => r.game)
}

export { gameInfo }
