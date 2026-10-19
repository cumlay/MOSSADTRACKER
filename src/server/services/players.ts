import { all, get, run } from '../db.ts'
import { broadcast } from '../events.ts'
import { resolvePlayer } from '../hive/client.ts'
import { bucketKey, bucketState } from '../hive/limiter.ts'
import { getPlayer } from '../queries.ts'
import { fetchBucket } from '../tracker/scheduler.ts'
import type { PlayerRow } from '../../shared/types.ts'

/**
 * Watchlist operations, shared by the HTTP API and the Discord bot so both behave
 * identically — same resolution, same baseline fetch, same error vocabulary.
 */

export type TrackFailure = 'not_found' | 'rate_limited' | 'already_tracked' | 'no_uuid' | 'network'

export type TrackResult =
  | { ok: true; player: PlayerRow }
  | { ok: false; reason: TrackFailure; retryAfter?: number; uuid?: string }

export async function trackPlayer(identifier: string): Promise<TrackResult> {
  const res = await resolvePlayer(identifier)
  if (!res.ok) {
    if (res.status === 404) return { ok: false, reason: 'not_found' }
    if (res.status === 429) return { ok: false, reason: 'rate_limited', retryAfter: res.retryAfter }
    return { ok: false, reason: 'network' }
  }

  const uuid = String(res.data.UUID ?? '')
  if (!uuid) return { ok: false, reason: 'no_uuid' }
  if (get('SELECT uuid FROM players WHERE uuid = ?', [uuid])) return { ok: false, reason: 'already_tracked', uuid }

  run('INSERT INTO players (uuid, username, username_cc, rank, enabled, added_at, tier) VALUES (?, ?, ?, ?, 1, ?, ?)', [
    uuid,
    String(res.data.username ?? identifier),
    res.data.username_cc ? String(res.data.username_cc) : null,
    res.data.rank ? String(res.data.rank) : null,
    Date.now(),
    'cold'
  ])

  // Baseline fetch right away so the player is not empty in the UI — but only when the
  // ledger allows it. Re-adding someone who was tracked earlier in the hour would
  // otherwise spend a slot Hive has already counted and take a 429; the scheduler picks
  // them up as soon as the bucket reopens anyway.
  if (bucketState(bucketKey(uuid, 'all')).nextAt <= Date.now()) {
    await fetchBucket(uuid, 'all')
  }
  const player = getPlayer(uuid)!
  broadcast('player', { uuid, player })
  return { ok: true, player }
}

export function untrackPlayer(uuid: string): void {
  for (const table of ['activity_events', 'sessions', 'stat_points', 'game_state', 'snapshots', 'monthly_stats']) {
    run(`DELETE FROM ${table} WHERE uuid = ?`, [uuid])
  }
  run('DELETE FROM players WHERE uuid = ?', [uuid])
  broadcast('removed', { uuid })
}

/**
 * Finds a tracked player by name without calling Hive — removing someone should not
 * cost API budget, and should work even while their bucket is on cooldown.
 */
export function findTracked(identifier: string): PlayerRow | null {
  const needle = identifier.trim().toLowerCase()
  const row = get<{ uuid: string }>(
    'SELECT uuid FROM players WHERE LOWER(username) = ? OR LOWER(username_cc) = ? OR LOWER(uuid) = ?',
    [needle, needle, needle]
  )
  if (row) return getPlayer(row.uuid)

  // Fall back to a unique partial match, so a small typo or a partial name still works.
  const matches = all<{ uuid: string; username: string }>(
    "SELECT uuid, username FROM players WHERE LOWER(username) LIKE '%' || ? || '%'",
    [needle]
  )
  return matches.length === 1 ? getPlayer(matches[0]!.uuid) : null
}
