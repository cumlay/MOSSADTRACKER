import type { Period } from './types.ts'

export interface LevelInfo {
  level: number
  max_level: number
  /** XP earned inside the current level. */
  xp_into_level: number
  /** XP the current level costs in total. */
  xp_for_level: number
  is_max: boolean
  prestige: number
  max_prestige: number
}

/** Where a card's numbers come from — it changes what they mean. */
export type StatSource = 'lifetime' | 'observed' | 'hive_month'

export interface StatCard {
  uuid: string
  username: string
  rank: string | null
  game: string
  period: Period | 'all'
  source: StatSource
  stats: Record<string, number>
  derived: { losses: number; win_rate: number; kdr: number | null; fklr: number | null }
  level: LevelInfo | null
  first_played: number | null
  /** Rank on Hive's monthly leaderboard, when the month figures came from there. */
  monthly_rank: number | null
}
