import { config } from '../config.ts'
import { all, get, j, run } from '../db.ts'
import { fetchMonthlyPlayer } from '../hive/client.ts'
import { bucketKey, bucketState } from '../hive/limiter.ts'

/**
 * Authoritative month-to-date totals, straight from Hive.
 *
 * Our own history only starts the day a player is added, which would leave the
 * monthly view empty for weeks. `/v0/game/monthly/player/...` returns the real
 * month total instead — at the cost of one slot in the (player, game) bucket, so
 * this refreshes lazily, at most once every few hours, and only for buckets that
 * currently have budget to spare.
 */

const TTL = 6 * 60 * 60 * 1000
/** Never spend more than this many buckets on one refresh. */
const MAX_GAMES = 3

interface CachedMonth {
  year: number
  month: number
  per_game: Record<string, Record<string, number>>
}

export async function refreshOfficialMonth(uuid: string, now = Date.now()): Promise<void> {
  const cached = get<{ fetched_at: number }>('SELECT fetched_at FROM meta_cache WHERE key = ?', [`monthly:${uuid}`])
  if (cached && now - cached.fetched_at < TTL) return

  // The games this player actually plays, busiest first.
  const games = all<{ game: string }>(
    "SELECT game FROM game_state WHERE uuid = ? AND played > 0 AND game NOT IN ('main', 'unknown') ORDER BY played DESC LIMIT ?",
    [uuid, MAX_GAMES]
  ).map((r) => r.game)
  if (games.length === 0) return

  const previous = get<{ value: string }>('SELECT value FROM meta_cache WHERE key = ?', [`monthly:${uuid}`])
  const d = new Date(now)
  const payload: CachedMonth = {
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    per_game: previous ? (JSON.parse(previous.value) as CachedMonth).per_game : {}
  }

  let fetched = 0
  for (const game of games) {
    const state = bucketState(bucketKey(uuid, game), now)

    // Activity tracking owns these buckets, so only borrow a slot when at least one
    // remains free afterwards. Note this bypasses our own 20-minute spacing rule but
    // never Hive's 3-per-hour quota — without it the game a player plays *most* would
    // never get month totals, since its bucket is the one permanently in use.
    if (state.blockedUntil !== null || state.used >= config.hive.bucketQuota - 1) continue

    const res = await fetchMonthlyPlayer(uuid, game)
    if (!res.ok) continue

    const stats: Record<string, number> = {}
    for (const [k, v] of Object.entries(res.data)) {
      if (typeof v === 'number' && k !== 'index' && k !== 'human_index') stats[k] = v
    }
    payload.per_game[game] = stats
    fetched++
  }

  if (fetched === 0 && !previous) return

  run(
    `INSERT INTO meta_cache (key, value, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, fetched_at = excluded.fetched_at`,
    [`monthly:${uuid}`, j(payload), now]
  )
}
