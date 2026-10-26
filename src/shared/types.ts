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
  tags: string[]
  group: Group | null
  /** Account that added the player (null for players added before this was recorded). */
  added_by: string | null
  /** Not seen for longer than the inactivity threshold. */
  inactive: boolean
  /** Set while the in-game client has this player in its lobby right now. */
  in_lobby: Sighting | null
}

export interface Group {
  id: number
  name: string
  color: string
  /** Discord channel this group's alerts go to; null = the default alert channel. */
  channel_id: string | null
}

export interface Note {
  id: number
  author: string
  body: string
  created_at: number
}

/** "Usually online 19:00–23:00, mostly Fri and Sat", from the 60-day heatmap. */
export interface Typical {
  /** Hours in the server's timezone; `to` is exclusive and may wrap past midnight. */
  from: number
  to: number
  /** Share of observed play inside that window, 0–1. */
  share: number
  /** Busiest weekdays, 0 = Monday. */
  days: number[]
  timezone: string
}

export interface PlayedWith {
  uuid: string
  username: string
  /** Sessions that overlapped in time on a shared game. */
  sessions: number
  last_at: number
  games: string[]
}

export interface TimelineSession extends Session {
  per_game: Record<string, number>
}

export interface AuditEntry {
  id: number
  at: number
  actor: string
  source: 'web' | 'discord' | 'system'
  action: string
  target_uuid: string | null
  target_name: string | null
  detail: string | null
}

export interface BotSettings {
  /** Post when a tracked player starts playing. */
  session_start: boolean
  /** Post a summary when a session ends. */
  session_end: boolean
  /** Level milestones, prestiges, win streaks. */
  milestones: boolean
  /** Post once when someone has not played for `inactive_days`. */
  inactivity: boolean
  daily_report: boolean
  weekly_report: boolean
  /** Local hour the reports go out at. */
  report_hour: number
  inactive_days: number
  /** How many players a limited (trackerUser) account may have on the watchlist. */
  user_add_limit: number
}

export interface Me {
  access: 'full' | 'user'
  name: string
  /** Players this account added that are still tracked, and its limit (limited accounts only). */
  added: number
  limit: number | null
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
    win_streak: number
    best_streak: number
  }>
  notes: Note[]
  typical: Typical | null
  played_with: PlayedWith[]
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

/** A tracked player seen in the same Hive lobby as the in-game client. */
export interface Sighting {
  uuid: string
  seen_at: number
  /** Hive sub-server, e.g. "BED-DUOS12". */
  server: string | null
  game: string | null
  mode: string | null
}

/** What the in-game client posts: the lobby it is in, and who is in it. */
export interface SightingReport {
  server?: string
  game?: string
  mode?: string
  reporter?: string
  players: Array<{ uuid?: string; name?: string }>
}
