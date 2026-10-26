import { config } from './config.ts'
import { all, get, unj } from './db.ts'
import { heatmap } from './queries.ts'
import { getGameMeta, levelFor } from './hive/meta.ts'
import type { PlayedWith, Session, TimelineSession, Typical } from '../shared/types.ts'

/**
 * Read-side analysis on top of the activity history: when someone usually plays, who
 * they play with, what a session or a day amounted to. Everything here is derived from
 * tables the tracker already keeps; none of it calls Hive except the cached level curve.
 */

const DAY = 24 * 60 * 60 * 1000

/* ------------------------------------------------------------ usual hours */

/** Below this much observed play the "usual hours" would be noise. */
const MIN_MINUTES = 90
/** The window grows until it holds this share of their play (or hits MAX_SPAN). */
const TARGET_SHARE = 0.7
const MAX_SPAN = 12

export function typicalHours(uuid: string, now = Date.now()): Typical | null {
  return typicalFromGrid(heatmap(uuid, 60, now))
}

/** Smallest daily window (wrapping past midnight) that holds most of the play. */
export function typicalFromGrid(grid: number[][]): Typical | null {
  const hourly = Array.from({ length: 24 }, (_, h) => grid.reduce((sum, row) => sum + (row[h] ?? 0), 0))
  const total = hourly.reduce((a, b) => a + b, 0)
  if (total < MIN_MINUTES) return null

  let best = { from: 0, span: MAX_SPAN, sum: -1 }
  for (let span = 1; span <= MAX_SPAN; span++) {
    best = { from: 0, span, sum: -1 }
    for (let from = 0; from < 24; from++) {
      let sum = 0
      for (let k = 0; k < span; k++) sum += hourly[(from + k) % 24]!
      if (sum > best.sum) best = { from, span, sum }
    }
    if (best.sum / total >= TARGET_SHARE) break
  }

  const perDay = grid.map((row, d) => ({ d, sum: row.reduce((a, b) => a + b, 0) }))
  const days = perDay
    .filter((x) => x.sum / total >= 0.18)
    .sort((a, b) => b.sum - a.sum)
    .slice(0, 3)
    .map((x) => x.d)

  return {
    from: best.from,
    to: (best.from + best.span) % 24,
    share: best.sum / total,
    days,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
  }
}

/* ----------------------------------------------------------- played with */

interface SessionRow {
  id: number
  uuid: string
  started_at: number
  ended_at: number
  matches: number
  games: string
}

const sharedGames = (a: string, b: string) => {
  const mine = new Set(unj<string[]>(a, []))
  return unj<string[]>(b, []).filter((g) => mine.has(g))
}

/**
 * Tracked players whose sessions overlapped this player's in time, on a game both were
 * playing. Detection windows are minutes wide, so this means "probably together", not
 * "same match" — which is why it counts sessions rather than single sightings.
 */
export function playedWith(uuid: string, days = 60, now = Date.now(), limit = 5): PlayedWith[] {
  const rows = all<{ other: string; g1: string; g2: string; end: number }>(
    `SELECT s2.uuid AS other, s1.games AS g1, s2.games AS g2, MIN(s1.ended_at, s2.ended_at) AS end
     FROM sessions s1
     JOIN sessions s2 ON s2.uuid != s1.uuid AND s2.started_at < s1.ended_at AND s1.started_at < s2.ended_at
     WHERE s1.uuid = ? AND s1.ended_at > ? AND s1.matches > 0 AND s2.matches > 0`,
    [uuid, now - days * DAY]
  )

  const by = new Map<string, { sessions: number; last_at: number; games: Set<string> }>()
  for (const r of rows) {
    const shared = sharedGames(r.g1, r.g2)
    if (shared.length === 0) continue
    const acc = by.get(r.other) ?? { sessions: 0, last_at: 0, games: new Set<string>() }
    acc.sessions++
    acc.last_at = Math.max(acc.last_at, r.end)
    for (const g of shared) acc.games.add(g)
    by.set(r.other, acc)
  }

  const names = new Map(
    all<{ uuid: string; name: string }>('SELECT uuid, COALESCE(username_cc, username) AS name FROM players').map((p) => [p.uuid, p.name])
  )
  return [...by.entries()]
    .filter(([other]) => names.has(other))
    .map(([other, v]) => ({ uuid: other, username: names.get(other)!, sessions: v.sessions, last_at: v.last_at, games: [...v.games] }))
    .sort((a, b) => b.sessions - a.sessions || b.last_at - a.last_at)
    .slice(0, limit)
}

/** Other tracked players in a running session on `gameId` right now. */
export function liveCompanions(uuid: string, gameId: string, now = Date.now()): string[] {
  const rows = all<{ name: string; games: string }>(
    `SELECT COALESCE(p.username_cc, p.username) AS name, s.games FROM sessions s
     JOIN players p ON p.uuid = s.uuid
     WHERE s.uuid != ? AND s.ended_at > ? AND s.matches > 0
       AND s.id = (SELECT id FROM sessions WHERE uuid = s.uuid ORDER BY ended_at DESC LIMIT 1)`,
    [uuid, now - config.scheduler.sessionGapMs]
  )
  return rows.filter((r) => unj<string[]>(r.games, []).includes(gameId)).map((r) => r.name)
}

/** Players whose session overlapped this one on a shared game. */
function companionsOf(session: SessionRow): string[] {
  return all<{ name: string; games: string }>(
    `SELECT DISTINCT COALESCE(p.username_cc, p.username) AS name, s.games FROM sessions s
     JOIN players p ON p.uuid = s.uuid
     WHERE s.uuid != ? AND s.started_at < ? AND ? < s.ended_at AND s.matches > 0`,
    [session.uuid, session.ended_at, session.started_at]
  )
    .filter((r) => sharedGames(session.games, r.games).length > 0)
    .map((r) => r.name)
    .filter((n, i, arr) => arr.indexOf(n) === i)
}

/* ------------------------------------------------------------------ levels */

/**
 * Level before and after an XP gain. `xpAfter` is the counter after the gain; levels
 * come from Hive's cached curve, so this is null when the curve is not available.
 */
export async function levelChange(gameId: string, xpAfter: number, gained: number): Promise<{ from: number; to: number; max: boolean } | null> {
  if (gained <= 0) return null
  const meta = await getGameMeta(gameId)
  if (!meta?.experienceToLevel) return null
  const before = levelFor(meta, Math.max(0, xpAfter - gained))
  const after = levelFor(meta, xpAfter)
  return { from: before.level, to: after.level, max: after.is_max }
}

/** XP counter for a game as it stood at `at`: today's value minus everything gained since. */
function xpAt(uuid: string, gameId: string, at: number): number | null {
  const state = get<{ xp: number }>('SELECT xp FROM game_state WHERE uuid = ? AND game = ?', [uuid, gameId])
  if (!state) return null
  let later = 0
  for (const r of all<{ delta: string }>('SELECT delta FROM activity_events WHERE uuid = ? AND game = ? AND window_end > ?', [uuid, gameId, at])) {
    later += unj<Record<string, number>>(r.delta, {}).xp ?? 0
  }
  return state.xp - later
}

/* ---------------------------------------------------------- session summary */

export interface SessionSummary {
  uuid: string
  name: string
  started_at: number
  ended_at: number
  matches: number
  games: Array<{ game: string; matches: number; wins: number; kills: number; levels: { from: number; to: number } | null }>
  with: string[]
}

export async function sessionSummary(sessionId: number): Promise<SessionSummary | null> {
  const s = get<SessionRow>('SELECT * FROM sessions WHERE id = ?', [sessionId])
  if (!s) return null
  const player = get<{ name: string }>('SELECT COALESCE(username_cc, username) AS name FROM players WHERE uuid = ?', [s.uuid])
  if (!player) return null

  const per = new Map<string, { matches: number; wins: number; kills: number; xp: number }>()
  for (const ev of all<{ game: string; matches: number; delta: string }>(
    "SELECT game, matches, delta FROM activity_events WHERE session_id = ? AND game != 'unknown'",
    [sessionId]
  )) {
    const d = unj<Record<string, number>>(ev.delta, {})
    const acc = per.get(ev.game) ?? { matches: 0, wins: 0, kills: 0, xp: 0 }
    acc.matches += ev.matches
    acc.wins += d.victories ?? 0
    acc.kills += d.kills ?? 0
    acc.xp += d.xp ?? 0
    per.set(ev.game, acc)
  }

  const games: SessionSummary['games'] = []
  for (const [game, v] of [...per.entries()].sort((a, b) => b[1].matches - a[1].matches)) {
    const xpEnd = xpAt(s.uuid, game, s.ended_at)
    const change = xpEnd === null ? null : await levelChange(game, xpEnd, v.xp)
    games.push({
      game,
      matches: v.matches,
      wins: v.wins,
      kills: v.kills,
      levels: change && change.to > change.from ? { from: change.from, to: change.to } : null
    })
  }

  return { uuid: s.uuid, name: player.name, started_at: s.started_at, ended_at: s.ended_at, matches: s.matches, games, with: companionsOf(s) }
}

/* ------------------------------------------------------------------ reports */

export interface Report {
  from: number
  to: number
  matches: number
  active: number
  top: Array<{ name: string; matches: number }>
  longest: { name: string; ms: number; matches: number; games: string[] } | null
  level_ups: Array<{ name: string; game: string; from: number; to: number }>
  top_game: { game: string; matches: number } | null
}

/** Activity between `from` and `to`, each detection counted at the middle of its window. */
export async function buildReport(from: number, to: number): Promise<Report> {
  const events = all<{ uuid: string; game: string; matches: number; delta: string; name: string }>(
    `SELECT e.uuid, e.game, e.matches, e.delta, COALESCE(p.username_cc, p.username) AS name
     FROM activity_events e JOIN players p ON p.uuid = e.uuid
     WHERE (e.window_start + e.window_end) / 2 >= ? AND (e.window_start + e.window_end) / 2 < ?`,
    [from, to]
  )

  const perPlayer = new Map<string, { name: string; matches: number }>()
  const perGame = new Map<string, number>()
  const xp = new Map<string, { uuid: string; name: string; game: string; gained: number }>()

  for (const e of events) {
    const p = perPlayer.get(e.uuid) ?? { name: e.name, matches: 0 }
    p.matches += e.matches
    perPlayer.set(e.uuid, p)
    if (e.game === 'unknown') continue
    if (e.matches > 0) perGame.set(e.game, (perGame.get(e.game) ?? 0) + e.matches)
    const gained = unj<Record<string, number>>(e.delta, {}).xp ?? 0
    if (gained > 0) {
      const key = `${e.uuid}:${e.game}`
      const acc = xp.get(key) ?? { uuid: e.uuid, name: e.name, game: e.game, gained: 0 }
      acc.gained += gained
      xp.set(key, acc)
    }
  }

  const levelUps: Report['level_ups'] = []
  for (const v of xp.values()) {
    const end = xpAt(v.uuid, v.game, to)
    const change = end === null ? null : await levelChange(v.game, end, v.gained)
    if (change && change.to > change.from) levelUps.push({ name: v.name, game: v.game, from: change.from, to: change.to })
  }

  const longest = get<{ name: string; ms: number; matches: number; games: string }>(
    `SELECT COALESCE(p.username_cc, p.username) AS name, s.ended_at - s.started_at AS ms, s.matches, s.games
     FROM sessions s JOIN players p ON p.uuid = s.uuid
     WHERE s.started_at >= ? AND s.started_at < ? AND s.matches > 0
     ORDER BY ms DESC LIMIT 1`,
    [from, to]
  )
  const topGame = [...perGame.entries()].sort((a, b) => b[1] - a[1])[0]
  const active = [...perPlayer.values()].filter((p) => p.matches > 0)

  return {
    from,
    to,
    matches: active.reduce((sum, p) => sum + p.matches, 0),
    active: active.length,
    top: active.sort((a, b) => b.matches - a.matches).slice(0, 5),
    longest: longest ? { name: longest.name, ms: longest.ms, matches: longest.matches, games: unj<string[]>(longest.games, []) } : null,
    level_ups: levelUps.sort((a, b) => b.to - b.from - (a.to - a.from)).slice(0, 5),
    top_game: topGame ? { game: topGame[0], matches: topGame[1] } : null
  }
}

/* ---------------------------------------------------------------- timeline */

/** Every session of the last `days` days, with matches per game for colouring. */
export function timeline(uuid: string, days = 56, now = Date.now()): TimelineSession[] {
  const sessions = all<SessionRow>('SELECT * FROM sessions WHERE uuid = ? AND ended_at > ? ORDER BY started_at', [uuid, now - days * DAY])
  if (sessions.length === 0) return []

  const perGame = new Map<number, Record<string, number>>()
  for (const r of all<{ session_id: number; game: string; n: number }>(
    `SELECT session_id, game, SUM(matches) AS n FROM activity_events
     WHERE uuid = ? AND session_id IS NOT NULL AND window_end > ? AND game != 'unknown'
     GROUP BY session_id, game`,
    [uuid, now - days * DAY - DAY]
  )) {
    const acc = perGame.get(r.session_id) ?? {}
    acc[r.game] = r.n
    perGame.set(r.session_id, acc)
  }

  return sessions.map((s) => ({
    id: s.id,
    uuid,
    started_at: s.started_at,
    ended_at: s.ended_at,
    matches: s.matches,
    games: unj<string[]>(s.games, []),
    per_game: perGame.get(s.id) ?? {}
  }))
}

/* --------------------------------------------------------------------- CSV */

function csv(rows: Array<Array<string | number | null>>): string {
  const cell = (v: string | number | null) => {
    const s = v === null ? '' : String(v)
    // Leading = + - @ would be read as a formula by spreadsheet apps.
    const safe = /^[=+\-@]/.test(s) && typeof v === 'string' ? `'${s}` : s
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
  }
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n'
}

const iso = (ts: number) => new Date(ts).toISOString()

export function sessionsCsv(uuid: string): string {
  const rows = all<Session & { games: string }>('SELECT * FROM sessions WHERE uuid = ? ORDER BY started_at', [uuid])
  return csv([
    ['started_at', 'ended_at', 'duration_min', 'matches', 'games'],
    ...rows.map((s) => [iso(s.started_at), iso(s.ended_at), Math.round((s.ended_at - s.started_at) / 60_000), s.matches, unj<string[]>(s.games, []).join(' ')])
  ])
}

export function statsCsv(uuid: string): string {
  const rows = all<{ game: string; played: number; victories: number; kills: number; deaths: number; xp: number; win_streak: number; best_streak: number; last_observed_at: number }>(
    "SELECT * FROM game_state WHERE uuid = ? AND game NOT IN ('main', 'unknown') ORDER BY played DESC",
    [uuid]
  )
  return csv([
    ['game', 'played', 'victories', 'losses', 'win_rate', 'kills', 'deaths', 'kd', 'xp', 'win_streak', 'best_streak', 'observed_at'],
    ...rows.map((r) => [
      r.game,
      r.played,
      r.victories,
      Math.max(0, r.played - r.victories),
      r.played > 0 ? (r.victories / r.played).toFixed(4) : '',
      r.kills,
      r.deaths,
      r.deaths > 0 ? (r.kills / r.deaths).toFixed(2) : '',
      r.xp,
      r.win_streak,
      r.best_streak,
      iso(r.last_observed_at)
    ])
  ])
}
