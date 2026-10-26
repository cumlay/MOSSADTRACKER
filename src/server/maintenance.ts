import { all, get, j, run, unj } from './db.ts'
import { NON_GAME_KEYS } from '../shared/games.ts'
import { refreshPlayerState } from './tracker/ingest.ts'

/** Raw payloads older than this are dropped; the derived tables keep the history. */
export const SNAPSHOT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Drops raw snapshots past the retention window.
 *
 * Snapshots are only useful to recompute derived data after a code change; the
 * counters, events and sessions we extract from them are what the app actually reads,
 * and those are kept forever. At ~14 kB per snapshot and ~1 400 fetches a day this is
 * the difference between a database that stabilises and one that grows without bound.
 */
export function pruneSnapshots(now = Date.now()): number {
  const cutoff = now - SNAPSHOT_RETENTION_MS
  const before = get<{ n: number }>('SELECT COUNT(*) AS n FROM snapshots WHERE fetched_at < ?', [cutoff])?.n ?? 0
  if (before === 0) return 0

  run('DELETE FROM snapshots WHERE fetched_at < ?', [cutoff])
  return before
}

/**
 * Removes data for game keys we no longer track (retired modes, or keys that were
 * never real games). Safe to run repeatedly.
 */
export function purgeRetiredGames(): Record<string, number> {
  const retired = [...NON_GAME_KEYS].filter((k) => k !== 'main')
  const removed: Record<string, number> = {}
  if (retired.length === 0) return removed

  const placeholders = retired.map(() => '?').join(', ')
  for (const table of ['activity_events', 'stat_points', 'game_state']) {
    const n = get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE game IN (${placeholders})`, retired)?.n ?? 0
    if (n > 0) {
      run(`DELETE FROM ${table} WHERE game IN (${placeholders})`, retired)
      removed[table] = n
    }
  }

  // Sessions keep a games array that may still mention a retired mode.
  let touched = 0
  for (const s of all<{ id: number; games: string }>('SELECT id, games FROM sessions')) {
    const games = unj<string[]>(s.games, [])
    const kept = games.filter((g) => !retired.includes(g))
    if (kept.length !== games.length) {
      run('UPDATE sessions SET games = ? WHERE id = ?', [j(kept), s.id])
      touched++
    }
  }
  if (touched > 0) removed.sessions = touched

  return removed
}

/**
 * Rebuilds every session from the activity events.
 *
 * Sessions are pure derived data, so whenever the grouping rule changes the old rows
 * are stale — in particular rows built while sessions were split on window *start*,
 * which glued hours of tracker downtime into a single implausible session.
 */
export function rebuildSessions(gapMs: number): { sessions: number; events: number } {
  run('DELETE FROM sessions')
  run('UPDATE activity_events SET session_id = NULL')

  const events = all<{ id: number; uuid: string; game: string; window_start: number; window_end: number; matches: number }>(
    'SELECT id, uuid, game, window_start, window_end, matches FROM activity_events ORDER BY uuid, window_end'
  )

  let sessions = 0
  const open = new Map<string, { id: number; endedAt: number; games: Set<string> }>()

  for (const ev of events) {
    const current = open.get(ev.uuid)

    if (current && ev.window_end - current.endedAt <= gapMs) {
      if (ev.game !== 'unknown') current.games.add(ev.game)
      current.endedAt = Math.max(current.endedAt, ev.window_end)
      run('UPDATE sessions SET ended_at = ?, matches = matches + ?, games = ? WHERE id = ?', [
        current.endedAt,
        ev.matches,
        j([...current.games]),
        current.id
      ])
      run('UPDATE activity_events SET session_id = ? WHERE id = ?', [current.id, ev.id])
      continue
    }

    const games = new Set<string>(ev.game === 'unknown' ? [] : [ev.game])
    // summary_sent = 1: a rebuild must not re-announce sessions that ended long ago.
    run('INSERT INTO sessions (uuid, started_at, ended_at, matches, games, summary_sent) VALUES (?, ?, ?, ?, ?, 1)', [
      ev.uuid,
      ev.window_start,
      ev.window_end,
      ev.matches,
      j([...games])
    ])
    const id = get<{ id: number }>('SELECT last_insert_rowid() AS id')!.id
    run('UPDATE activity_events SET session_id = ? WHERE id = ?', [id, ev.id])
    open.set(ev.uuid, { id, endedAt: ev.window_end, games })
    sessions++
  }

  return { sessions, events: events.length }
}

/**
 * Recomputes the denormalized columns on `players` from the activity events.
 *
 * `last_seen_at`, its uncertainty and the polling tier are all derived, so whenever
 * the rule behind them changes the stored values are stale until each player happens
 * to be fetched again. Running this at boot makes the change take effect at once.
 */
export function refreshAllPlayers(now = Date.now()): number {
  const players = all<{ uuid: string }>('SELECT uuid FROM players')
  for (const p of players) refreshPlayerState(p.uuid, now)
  return players.length
}

/** Reclaims the file space freed by a large delete. */
export function vacuum(): void {
  run('VACUUM')
}
