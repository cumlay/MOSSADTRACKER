import { all, get, run } from './db.ts'
import { config } from './config.ts'
import { broadcast } from './events.ts'
import { postAlert } from './notifier.ts'
import { sightingEmbed } from './embeds.ts'
import { recordEvent, refreshPlayerState } from './tracker/ingest.ts'
import { getPlayer } from './queries.ts'
import { game as gameInfo } from '../shared/games.ts'


/**
 * Players seen in the same Hive lobby as the in-game client.
 *
 * This is a different kind of evidence from everything else the tracker holds. A
 * counter delta says "they finished a match somewhere in this window"; a sighting says
 * "they were on this server at this instant", with no uncertainty at all. It therefore
 * enters the activity pipeline as a zero-width event, which makes the player's status
 * exact instead of approximate.
 */

/** The same player on the same server is only recorded again after this long. */
const DEDUPE_MS = 5 * 60 * 1000

interface TrackedRow {
  uuid: string
  username: string
  username_cc: string | null
}

/** Everything the in-game client needs to recognise a tracked player in a lobby. */
export function roster(): Array<{ uuid: string; name: string }> {
  return all<TrackedRow>('SELECT uuid, username, username_cc FROM players WHERE enabled = 1').map((p) => ({
    uuid: p.uuid,
    name: p.username_cc ?? p.username
  }))
}

function findTracked(uuid: string | undefined, name: string | undefined): TrackedRow | undefined {
  if (uuid) {
    const byUuid = get<TrackedRow>('SELECT uuid, username, username_cc FROM players WHERE uuid = ?', [uuid])
    if (byUuid) return byUuid
  }
  if (!name) return undefined
  // Gamertags are matched case-insensitively: the player list shows the cased name.
  return get<TrackedRow>('SELECT uuid, username, username_cc FROM players WHERE username = ?', [name.toLowerCase()])
}

export interface SightingContext {
  server?: string
  game?: string
  mode?: string
  reporter?: string
}

export interface RecordResult {
  /** Players matched against the watchlist, whether or not a row was written. */
  matched: number
  /** Rows actually written (the rest were inside the dedupe window). */
  recorded: number
  names: string[]
}

/**
 * Records a batch of players seen together in one lobby.
 *
 * The client reports the whole lobby, so this is the only place that decides what is
 * new: reporting the same roster every few seconds must not produce a row, an alert or
 * a Discord ping each time.
 */
export async function recordSightings(
  players: Array<{ uuid?: string; name?: string }>,
  context: SightingContext = {},
  now = Date.now()
): Promise<RecordResult> {
  const result: RecordResult = { matched: 0, recorded: 0, names: [] }
  const server = context.server?.slice(0, 48) ?? null
  const gameId = context.game?.slice(0, 24) ?? null

  for (const seen of players) {
    const tracked = findTracked(seen.uuid, seen.name)
    if (!tracked) continue
    result.matched++

    const last = get<{ seen_at: number; server: string | null }>(
      'SELECT seen_at, server FROM sightings WHERE uuid = ? ORDER BY seen_at DESC LIMIT 1',
      [tracked.uuid]
    )
    // A new server always counts as news, even inside the dedupe window: they moved.
    const sameSpot = last && last.server === server
    if (sameSpot && now - last.seen_at < DEDUPE_MS) continue

    run('INSERT INTO sightings (uuid, seen_at, server, game, mode, reporter) VALUES (?, ?, ?, ?, ?, ?)', [
      tracked.uuid,
      now,
      server,
      gameId,
      context.mode?.slice(0, 24) ?? null,
      context.reporter?.slice(0, 32) ?? null
    ])

    // Zero-width window: we saw them, there is nothing to be uncertain about.
    recordEvent(tracked.uuid, {
      game: gameId && gameInfo(gameId).id === gameId ? gameId : 'unknown',
      matches: 0,
      windowStart: now,
      windowEnd: now,
      delta: {}
    })
    refreshPlayerState(tracked.uuid, now)

    const name = tracked.username_cc ?? tracked.username
    result.recorded++
    result.names.push(name)

    broadcast('sighting', { uuid: tracked.uuid, name, server, game: gameId, seen_at: now })
    broadcast('player', { uuid: tracked.uuid, player: getPlayer(tracked.uuid, now) })

    await postAlert(sightingEmbed(name, gameId, server, context.mode ?? null, now), tracked.uuid)
  }

  return result
}

/** Drops sightings older than the activity history needs. */
export function pruneSightings(now = Date.now()): number {
  const cutoff = now - 90 * 24 * 60 * 60 * 1000
  const n = get<{ n: number }>('SELECT COUNT(*) AS n FROM sightings WHERE seen_at < ?', [cutoff])?.n ?? 0
  if (n > 0) run('DELETE FROM sightings WHERE seen_at < ?', [cutoff])
  return n
}

/** True when the in-game client is allowed to talk to this server at all. */
export function clientLinkEnabled(): boolean {
  return config.clientToken.length > 0
}
