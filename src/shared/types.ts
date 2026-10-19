/** Types shared by the Fastify API and the React front-end. */

export type Tier = 'hot' | 'warm' | 'cold' | 'dormant'
export type Status = 'live' | 'recent' | 'today' | 'idle' | 'stale' | 'unknown'

export interface Player {
  uuid: string
  username: string
  username_cc: string | null
  rank: string | null
  enabled: 0 | 1
  /** Whether session-start alerts fire for this player. */
  notify: 0 | 1
  added_at: number
  tier: Tier
  /** End of the most recent activity window (ms). */
  last_seen_at: number | null
  /** Width of that window in ms — our uncertainty on `last_seen_at`. */
  last_seen_window_ms: number | null
  last_game: string | null
  last_fetch_at: number | null
  /** When the next API fetch for this player is due, and which bucket it will spend. */
  next_fetch_at: number | null
  next_fetch_bucket: string | null
  first_played: number | null
  player_number: number | null
}

export interface PlayerRow extends Player {
  status: Status
  /** Matches finished in the last 24 h / 7 d / 30 d, from activity events. */
  matches_24h: number
  matches_7d: number
  matches_30d: number
  /** Currently running session, if any. */
  session: { started_at: number; matches: number; games: string[] } | null
}

export interface ActivityEvent {
  id: number
  uuid: string
  game: string
  window_start: number
  window_end: number
  matches: number
  delta: Record<string, number>
}

export interface Session {
  id: number
  uuid: string
  started_at: number
  ended_at: number
  matches: number
  games: string[]
}

export interface StatPoint {
  game: string
  observed_at: number
  played: number
  victories: number
  xp: number
  kills: number
  deaths: number
  extra: Record<string, number>
}

export interface PlayerDetail {
  player: PlayerRow
  games: Array<{
    game: string
    latest: StatPoint
    delta_24h: Record<string, number> | null
    delta_7d: Record<string, number> | null
  }>
  sessions: Session[]
  events: ActivityEvent[]
  /** 7 x 24 grid of minutes-of-observed-activity, index [weekday][hour], weekday 0 = Monday. */
  heatmap: number[][]
  profile: Record<string, unknown> | null
}

export interface SearchResult {
  uuid: string
  username: string
  username_cc: string | null
  tracked: boolean
}

export type Period = 'day' | 'week' | 'month'

export interface HistoryBucket {
  start: number
  end: number
  label: string
  matches: number
  /** Matches per game inside this bucket. */
  per_game: Record<string, number>
  /** Summed deltas across every game (victories, kills, deaths, xp…). */
  totals: Record<string, number>
  /**
   * False when the bucket predates the moment we started watching this player — an
   * empty bucket then means "no data", not "did not play".
   */
  tracked: boolean
  /** 'hive' means the figures come from a monthly leaderboard, not from our sampling. */
  source: 'observed' | 'hive'
}

export interface HistoryResponse {
  period: Period
  tracking_since: number
  buckets: HistoryBucket[]
  /** Authoritative month totals straight from Hive, when we have them cached. */
  official_month: {
    fetched_at: number
    year: number
    month: number
    per_game: Record<string, Record<string, number>>
  } | null
}

export interface SchedulerStatus {
  running: boolean
  tick_ms: number
  global_used_last_minute: number
  global_limit: number
  /** Counters that survive log pruning: every call made since setup. */
  lifetime: { requests: number; errors: number; since: number }
  next_fetches: Array<{ uuid: string; username: string; bucket: string; due_at: number }>
  recent_fetches: Array<{ uuid: string | null; bucket: string; at: number; status: number; ms: number }>
}
