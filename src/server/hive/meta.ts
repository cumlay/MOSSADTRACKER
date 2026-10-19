import { get, j, run, unj } from '../db.ts'
import { gameMeta } from './client.ts'
import type { LevelInfo } from '../../shared/stats.ts'

/**
 * Game metadata (XP curve, level cap, prestige rules).
 *
 * `/v0/game/meta/{game}` is static and carries no per-player rate limit, so it is
 * cached for a day and shared by every player.
 */

const TTL = 24 * 60 * 60 * 1000

export interface GameMeta {
  name: string
  shortName: string
  maxLevel: number
  allowPrestiging: boolean
  maxPrestige: number
  /** XP threshold -> table index. The displayed level is that index + 1. */
  experienceToLevel: Record<string, number>
}

export async function getGameMeta(gameId: string, now = Date.now()): Promise<GameMeta | null> {
  const cached = get<{ value: string; fetched_at: number }>('SELECT value, fetched_at FROM meta_cache WHERE key = ?', [
    `meta:${gameId}`
  ])
  if (cached && now - cached.fetched_at < TTL) return unj<GameMeta | null>(cached.value, null)

  const res = await gameMeta(gameId)
  if (!res.ok) return cached ? unj<GameMeta | null>(cached.value, null) : null

  run(
    `INSERT INTO meta_cache (key, value, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, fetched_at = excluded.fetched_at`,
    [`meta:${gameId}`, j(res.data), now]
  )
  return res.data as unknown as GameMeta
}

/**
 * Turns raw XP into a level + progress bar.
 *
 * The API's table maps "XP threshold -> index", where index 0 sits at 0 XP; Hive
 * displays that as level 1, so everything is shifted by one. Above the last listed
 * threshold the curve is flat, so the final step is reused to reach the cap.
 */
export function levelFor(meta: GameMeta, xp: number, prestige = 0): LevelInfo {
  const table = Object.entries(meta.experienceToLevel)
    .map(([threshold, index]) => [Number(threshold), index] as const)
    .sort((a, b) => a[0] - b[0])

  const last = table[table.length - 1]
  const secondLast = table[table.length - 2]
  const step = last && secondLast ? last[0] - secondLast[0] : 0

  let index = 0
  let floor = 0
  let ceiling = last ? last[0] : 0

  for (let i = 0; i < table.length; i++) {
    const [threshold, idx] = table[i]!
    if (xp >= threshold) {
      index = idx
      floor = threshold
      ceiling = table[i + 1]?.[0] ?? threshold + step
    } else break
  }

  const level = Math.min(meta.maxLevel, index + 1)
  const isMax = level >= meta.maxLevel

  return {
    level,
    max_level: meta.maxLevel,
    xp_into_level: isMax ? Math.max(0, ceiling - floor) : xp - floor,
    xp_for_level: Math.max(1, ceiling - floor),
    is_max: isMax,
    prestige,
    max_prestige: meta.allowPrestiging ? meta.maxPrestige : 0
  }
}
