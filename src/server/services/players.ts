import { all, get, run } from '../db.ts'
import { broadcast } from '../events.ts'
import { resolvePlayer } from '../hive/client.ts'
import { bucketKey, bucketState } from '../hive/limiter.ts'
import { getPlayer } from '../queries.ts'
import { fetchBucket } from '../tracker/scheduler.ts'
import { audit, SYSTEM, type Actor } from '../audit.ts'
import { getBotSettings } from '../settings.ts'
import type { PlayerRow } from '../../shared/types.ts'

/**
 * Watchlist operations, shared by the HTTP API and the Discord bot so both behave
 * identically — same resolution, same baseline fetch, same error vocabulary.
 */

export type TrackFailure = 'not_found' | 'rate_limited' | 'already_tracked' | 'no_uuid' | 'network' | 'limit'

export type TrackResult =
  | { ok: true; player: PlayerRow }
  | { ok: false; reason: TrackFailure; retryAfter?: number; uuid?: string; limit?: number }

/** Players this account added that are still on the watchlist. */
export function addedBy(name: string): number {
  return get<{ n: number }>('SELECT COUNT(*) AS n FROM players WHERE added_by = ?', [name])?.n ?? 0
}

/** The add limit that applies to `actor`, or null when it has none (full access). */
export function addLimit(actor: Actor): number | null {
  return actor.access === 'user' ? getBotSettings().user_add_limit : null
}

export async function trackPlayer(identifier: string, actor: Actor = SYSTEM): Promise<TrackResult> {
  // Checked before calling Hive: a refused add should not cost API budget.
  const limit = addLimit(actor)
  if (limit !== null && addedBy(actor.name) >= limit) return { ok: false, reason: 'limit', limit }

  const res = await resolvePlayer(identifier)
  if (!res.ok) {
    if (res.status === 404) return { ok: false, reason: 'not_found' }
    if (res.status === 429) return { ok: false, reason: 'rate_limited', retryAfter: res.retryAfter }
    return { ok: false, reason: 'network' }
  }

  const uuid = String(res.data.UUID ?? '')
  if (!uuid) return { ok: false, reason: 'no_uuid' }
  if (get('SELECT uuid FROM players WHERE uuid = ?', [uuid])) return { ok: false, reason: 'already_tracked', uuid }

  const name = String(res.data.username_cc ?? res.data.username ?? identifier)
  run('INSERT INTO players (uuid, username, username_cc, rank, enabled, added_at, tier, added_by) VALUES (?, ?, ?, ?, 1, ?, ?, ?)', [
    uuid,
    String(res.data.username ?? identifier),
    res.data.username_cc ? String(res.data.username_cc) : null,
    res.data.rank ? String(res.data.rank) : null,
    Date.now(),
    'cold',
    actor.name
  ])
  audit(actor, 'track', { uuid, name })

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

export function untrackPlayer(uuid: string, actor: Actor = SYSTEM): void {
  const p = get<{ name: string }>('SELECT COALESCE(username_cc, username) AS name FROM players WHERE uuid = ?', [uuid])
  for (const table of ['activity_events', 'sessions', 'stat_points', 'game_state', 'snapshots', 'monthly_stats', 'player_notes']) {
    run(`DELETE FROM ${table} WHERE uuid = ?`, [uuid])
  }
  run('DELETE FROM players WHERE uuid = ?', [uuid])
  if (p) audit(actor, 'untrack', { uuid, name: p.name }, 'history deleted')
  broadcast('removed', { uuid })
}

/** Pause/resume polling and mute/unmute alerts. Returns null when the player is unknown. */
export function setPlayerFlags(uuid: string, flags: { enabled?: boolean; notify?: boolean }, actor: Actor = SYSTEM): PlayerRow | null {
  const p = get<{ name: string }>('SELECT COALESCE(username_cc, username) AS name FROM players WHERE uuid = ?', [uuid])
  if (!p) return null
  const target = { uuid, name: p.name }
  if (typeof flags.enabled === 'boolean') {
    run('UPDATE players SET enabled = ? WHERE uuid = ?', [flags.enabled ? 1 : 0, uuid])
    audit(actor, flags.enabled ? 'resume' : 'pause', target)
  }
  if (typeof flags.notify === 'boolean') {
    run('UPDATE players SET notify = ? WHERE uuid = ?', [flags.notify ? 1 : 0, uuid])
    audit(actor, flags.notify ? 'alerts on' : 'alerts off', target)
  }
  const player = getPlayer(uuid)
  broadcast('player', { uuid, player })
  return player
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
