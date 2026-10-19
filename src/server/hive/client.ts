import { config } from '../config.ts'
import { bucketKey, canFetch, logFetch, remapBucket, reserve } from './limiter.ts'

export type HiveResult<T> =
  | { ok: true; data: T; status: number }
  | { ok: false; status: number; error: string; retryAfter?: number }

async function request<T>(path: string, opts: { bucket?: string; uuid?: string | null; headers?: Record<string, string> } = {}): Promise<HiveResult<T>> {
  const bucket = opts.bucket ?? `raw:${path}`
  const started = Date.now()
  reserve(bucket, started)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.hive.timeoutMs)

  try {
    const res = await fetch(config.hive.base + path, {
      headers: { 'User-Agent': config.hive.userAgent, Accept: 'application/json', ...opts.headers },
      signal: controller.signal
    })
    const retryAfter = res.headers.get('retry-after')
    const duration = Date.now() - started

    logFetch({
      uuid: opts.uuid ?? null,
      bucket,
      requestedAt: started,
      status: res.status,
      durationMs: duration,
      retryAfter: retryAfter ? Number(retryAfter) : null
    })

    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: res.status === 404 ? 'not_found' : res.status === 429 ? 'rate_limited' : `http_${res.status}`,
        retryAfter: retryAfter ? Number(retryAfter) : undefined
      }
    }
    return { ok: true, status: res.status, data: (await res.json()) as T }
  } catch (err) {
    logFetch({ uuid: opts.uuid ?? null, bucket, requestedAt: started, status: 0, durationMs: Date.now() - started })
    return { ok: false, status: 0, error: err instanceof Error ? err.message : 'network_error' }
  } finally {
    clearTimeout(timer)
  }
}

export type GamePayload = Record<string, number | string | null>
export type AllPayload = Record<string, GamePayload>

/**
 * `all` bucket: every game in a single request. This is the workhorse — it costs
 * one bucket slot and returns the whole player.
 */
export function fetchAll(uuid: string): Promise<HiveResult<AllPayload>> {
  return request<AllPayload>(`/v0/game/all/all/${uuid}`, { bucket: bucketKey(uuid, 'all'), uuid })
}

/**
 * `main` bucket: account profile. `quest_count` moves while the player is in a match,
 * so this is our "something is happening" probe between two `all` fetches.
 */
export async function fetchMain(uuid: string): Promise<HiveResult<GamePayload>> {
  const res = await request<{ main?: GamePayload } & GamePayload>(`/v0/game/all/main/${uuid}`, {
    bucket: bucketKey(uuid, 'main'),
    uuid,
    headers: { 'X-Hive-Resolve-Stat-Track': 'true', 'X-Hive-Resolve-Dynamic-Hub-Titles': 'true' }
  })
  if (!res.ok) return res
  // /v0/game/all/main/{id} wraps its payload in { "main": {...} }; all/all does not.
  const data = (res.data.main ?? res.data) as GamePayload
  return { ok: true, status: res.status, data }
}

/** One game's counters — used to tighten resolution on the game a player is currently on. */
export function fetchGame(uuid: string, gameId: string): Promise<HiveResult<GamePayload>> {
  return request<GamePayload>(`/v0/game/all/${gameId}/${uuid}`, { bucket: bucketKey(uuid, gameId), uuid })
}

/**
 * Month-to-date stats for one player in one game. Shares the (player, game) bucket
 * with fetchGame — verified: burning one 429s the other.
 */
export function fetchMonthlyPlayer(uuid: string, gameId: string): Promise<HiveResult<GamePayload>> {
  return request<GamePayload>(`/v0/game/monthly/player/${gameId}/${uuid}`, { bucket: bucketKey(uuid, gameId), uuid })
}

export interface SearchHit {
  UUID: string
  username: string
  username_cc: string | null
}

/** Not subject to the per-combination limit. Requires >= 4 characters. */
export function searchPlayers(partial: string): Promise<HiveResult<SearchHit[]>> {
  return request<SearchHit[]>(`/v0/player/search/${encodeURIComponent(partial)}`, { bucket: 'search' })
}

/** Resolves a username to its UUID + cased name (also works when given a UUID). */
export async function resolvePlayer(identifier: string): Promise<HiveResult<GamePayload>> {
  const fromBucket = bucketKey(identifier, 'main')
  const res = await request<{ main?: GamePayload } & GamePayload>(`/v0/game/all/main/${encodeURIComponent(identifier)}`, {
    bucket: fromBucket,
    uuid: null
  })
  if (!res.ok) return res

  const data = (res.data.main ?? res.data) as GamePayload
  const uuid = typeof data.UUID === 'string' ? data.UUID : null
  // Hive counts this request against the (player, main) bucket regardless of the form
  // used to address them, so the ledger has to agree.
  if (uuid) remapBucket(fromBucket, bucketKey(uuid, 'main'), uuid)

  return { ok: true, status: res.status, data }
}

/**
 * Top 100 of a month's leaderboard. No per-(player, game) limit applies here — only the
 * global one — which is what makes rebuilding history cheap.
 */
export function monthlyLeaderboard(
  gameId: string,
  year: number,
  month: number
): Promise<HiveResult<Array<Record<string, unknown>>>> {
  return request(`/v0/game/monthly/${gameId}/${year}/${month}/100/0`, { bucket: 'leaderboard' })
}

export function gameMeta(gameId: string): Promise<HiveResult<Record<string, unknown>>> {
  return request(`/v0/game/meta/${gameId}`, { bucket: `meta:${gameId}` })
}

export function globalStatistics(): Promise<HiveResult<{ unique_players: Record<string, number> }>> {
  return request('/v0/global/statistics', { bucket: 'global' })
}

export { canFetch }
