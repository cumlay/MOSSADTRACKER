import { all, get, unj } from './db.ts'
import { getGameMeta, levelFor } from './hive/meta.ts'
import type { Period } from '../shared/types.ts'
import type { StatCard, StatSource } from '../shared/stats.ts'

/**
 * One game's stat card for one player, scoped to a period.
 *
 * `all` reads the lifetime counters we hold; the shorter periods are summed from our
 * own observed deltas; `month` prefers Hive's authoritative month-to-date figures when
 * we have them cached, because those also cover the part of the month that happened
 * before this player joined the watchlist.
 */

function startOfPeriod(period: Period, now: number): number {
  const d = new Date(now)
  if (period === 'month') return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  if (period === 'week') day.setDate(day.getDate() - ((day.getDay() + 6) % 7))
  return day.getTime()
}

/** Sums our observed deltas for one game since `since`. */
function observedSince(uuid: string, game: string, since: number): Record<string, number> {
  const rows = all<{ delta: string; matches: number }>(
    'SELECT delta, matches FROM activity_events WHERE uuid = ? AND game = ? AND window_end >= ?',
    [uuid, game, since]
  )
  const out: Record<string, number> = {}
  for (const r of rows) {
    for (const [k, v] of Object.entries(unj<Record<string, number>>(r.delta, {}))) {
      out[k] = (out[k] ?? 0) + v
    }
  }
  return out
}

export async function statCard(
  uuid: string,
  game: string,
  period: Period | 'all',
  now = Date.now()
): Promise<StatCard | null> {
  const player = get<{ username: string; username_cc: string | null; rank: string | null; first_played: number | null }>(
    'SELECT username, username_cc, rank, first_played FROM players WHERE uuid = ?',
    [uuid]
  )
  if (!player) return null

  const state = get<{ played: number; victories: number; xp: number; kills: number; deaths: number; extra: string }>(
    'SELECT played, victories, xp, kills, deaths, extra FROM game_state WHERE uuid = ? AND game = ?',
    [uuid, game]
  )
  if (!state) return null

  const lifetime: Record<string, number> = {
    played: state.played,
    victories: state.victories,
    xp: state.xp,
    kills: state.kills,
    deaths: state.deaths,
    ...unj<Record<string, number>>(state.extra, {})
  }

  let stats = lifetime
  let source: StatSource = 'lifetime'
  let monthlyRank: number | null = null

  if (period !== 'all') {
    stats = observedSince(uuid, game, startOfPeriod(period, now))
    source = 'observed'

    if (period === 'month') {
      const cached = get<{ value: string }>('SELECT value FROM meta_cache WHERE key = ?', [`monthly:${uuid}`])
      const official = cached
        ? unj<{ per_game: Record<string, Record<string, number>> }>(cached.value, { per_game: {} }).per_game[game]
        : undefined
      if (official) {
        const { human_index, index, ...rest } = official
        stats = rest
        source = 'hive_month'
        monthlyRank = human_index ?? null
      }
    }
  }

  const played = stats.played ?? 0
  const victories = stats.victories ?? 0
  const deaths = stats.deaths ?? 0

  // Lifetime XP is what drives the level bar; a period slice has no level of its own.
  const meta = period === 'all' ? await getGameMeta(game, now) : null

  return {
    uuid,
    username: player.username_cc ?? player.username,
    rank: player.rank,
    game,
    period,
    source,
    stats,
    derived: {
      losses: Math.max(0, played - victories),
      win_rate: played > 0 ? victories / played : 0,
      kdr: stats.kills !== undefined ? (deaths > 0 ? stats.kills / deaths : stats.kills) : null,
      fklr: stats.final_kills !== undefined ? (deaths > 0 ? stats.final_kills / deaths : stats.final_kills) : null
    },
    level: meta ? levelFor(meta, lifetime.xp ?? 0, lifetime.prestige ?? 0) : null,
    // Each game carries its own first_played; the account date is only a fallback.
    first_played: lifetime.first_played ?? player.first_played,
    monthly_rank: monthlyRank
  }
}
