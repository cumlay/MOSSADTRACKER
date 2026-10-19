/**
 * Dev tool: replays a synthetic "player finished N matches" observation through the
 * real ingest pipeline, so the delta -> event -> session -> status chain can be
 * exercised without burning API quota.
 *
 *   node --disable-warning=ExperimentalWarning scripts/simulate-activity.ts <username> [game] [matches] [minutesAgo]
 */
import { all, get, unj } from '../src/server/db.ts'
import { ingestAll } from '../src/server/tracker/ingest.ts'
import { listPlayers } from '../src/server/queries.ts'

const [, , nameArg = '', gameArg = 'sky', matchesArg = '2', agoArg = '0'] = process.argv
const matches = Number(matchesArg)
const at = Date.now() - Number(agoArg) * 60_000

const player = get<{ uuid: string; username: string }>(
  'SELECT uuid, username FROM players WHERE username = ? OR username_cc = ? OR uuid = ?',
  [nameArg.toLowerCase(), nameArg, nameArg]
)
if (!player) {
  console.error(`no tracked player matching "${nameArg}"`)
  process.exit(1)
}

const state = get<{ played: number; victories: number; xp: number; kills: number; deaths: number; extra: string }>(
  'SELECT played, victories, xp, kills, deaths, extra FROM game_state WHERE uuid = ? AND game = ?',
  [player.uuid, gameArg]
)
if (!state) {
  console.error(`no baseline for ${player.username} / ${gameArg} — add the player first`)
  process.exit(1)
}

const payload = {
  [gameArg]: {
    UUID: player.uuid,
    ...unj<Record<string, number>>(state.extra, {}),
    played: state.played + matches,
    victories: state.victories + Math.max(0, matches - 1),
    xp: state.xp + matches * 250,
    kills: state.kills + matches * 3,
    deaths: state.deaths + 1
  }
}

const result = ingestAll(player.uuid, payload as never, at)
console.log(`ingested: ${result.changed.length} changed game(s)`)
for (const c of result.changed) {
  console.log(`  ${c.game}: +${c.matches} matches, window ${new Date(c.windowStart).toLocaleTimeString()} → ${new Date(c.windowEnd).toLocaleTimeString()}`, c.delta)
}

const row = listPlayers().find((p) => p.uuid === player.uuid)!
console.log('\nplayer state:', {
  status: row.status,
  tier: row.tier,
  last_game: row.last_game,
  matches_24h: row.matches_24h,
  window_ms: row.last_seen_window_ms,
  session: row.session
})
console.log('\nevents:', all('SELECT game, window_start, window_end, matches, session_id FROM activity_events WHERE uuid = ? ORDER BY id DESC LIMIT 5', [player.uuid]))
console.log('sessions:', all('SELECT id, started_at, ended_at, matches, games FROM sessions WHERE uuid = ?', [player.uuid]))
