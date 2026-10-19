import { config } from './config.ts'
import { all, get, unj } from './db.ts'
import { nextFetchFor } from './tracker/scheduler.ts'
import type { ActivityEvent, HistoryBucket, HistoryResponse, Period, PlayerDetail, PlayerRow, Session, StatPoint, Status } from '../shared/types.ts'

const DAY = 24 * 60 * 60 * 1000

export function statusOf(lastSeenAt: number | null, now = Date.now()): Status {
  if (lastSeenAt === null) return 'unknown'
  const age = now - lastSeenAt
  if (age <= config.scheduler.liveWindowMs) return 'live'
  if (age <= 60 * 60 * 1000) return 'recent'
  if (age <= DAY) return 'today'
  if (age <= 7 * DAY) return 'idle'
  return 'stale'
}

interface PlayerDbRow {
  uuid: string
  username: string
  username_cc: string | null
  rank: string | null
  enabled: 0 | 1
  notify: 0 | 1
  added_at: number
  tier: PlayerRow['tier']
  last_seen_at: number | null
  last_seen_window_ms: number | null
  last_game: string | null
  last_fetch_at: number | null
  first_played: number | null
  player_number: number | null
  profile: string | null
}

function toRow(p: PlayerDbRow, now: number): PlayerRow {
  const since = (ms: number) =>
    get<{ n: number }>('SELECT COALESCE(SUM(matches), 0) AS n FROM activity_events WHERE uuid = ? AND window_end > ?', [
      p.uuid,
      now - ms
    ])?.n ?? 0
  const session = get<{ started_at: number; ended_at: number; matches: number; games: string }>(
    'SELECT started_at, ended_at, matches, games FROM sessions WHERE uuid = ? ORDER BY ended_at DESC LIMIT 1',
    [p.uuid]
  )
  const live = session && now - session.ended_at <= config.scheduler.sessionGapMs
  const next = nextFetchFor(p.uuid, p.tier, now)

  return {
    uuid: p.uuid,
    username: p.username,
    username_cc: p.username_cc,
    rank: p.rank,
    enabled: p.enabled,
    notify: p.notify ?? 1,
    added_at: p.added_at,
    tier: p.tier,
    last_seen_at: p.last_seen_at,
    last_seen_window_ms: p.last_seen_window_ms,
    last_game: p.last_game,
    last_fetch_at: p.last_fetch_at,
    next_fetch_at: p.enabled ? next.dueAt : null,
    next_fetch_bucket: p.enabled ? next.bucket : null,
    first_played: p.first_played,
    player_number: p.player_number,
    status: statusOf(p.last_seen_at, now),
    matches_24h: since(DAY),
    matches_7d: since(7 * DAY),
    matches_30d: since(30 * DAY),
    session: live ? { started_at: session.started_at, matches: session.matches, games: unj<string[]>(session.games, []) } : null
  }
}

export function listPlayers(now = Date.now()): PlayerRow[] {
  const rows = all<PlayerDbRow>('SELECT * FROM players ORDER BY COALESCE(last_seen_at, 0) DESC, username ASC')
  return rows.map((r) => toRow(r, now))
}

export function getPlayer(uuid: string, now = Date.now()): PlayerRow | null {
  const row = get<PlayerDbRow>('SELECT * FROM players WHERE uuid = ?', [uuid])
  return row ? toRow(row, now) : null
}

/* ------------------------------------------------------------ period history */

/** Start of the local day / ISO week (Monday) / month containing `ts`. */
function bucketStart(period: Period, ts: number): number {
  const d = new Date(ts)
  if (period === 'month') return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  if (period === 'week') {
    const shift = (day.getDay() + 6) % 7 // Monday = 0
    day.setDate(day.getDate() - shift)
  }
  return day.getTime()
}

function stepBucket(period: Period, start: number): number {
  const d = new Date(start)
  if (period === 'day') d.setDate(d.getDate() + 1)
  else if (period === 'week') d.setDate(d.getDate() + 7)
  else d.setMonth(d.getMonth() + 1)
  return d.getTime()
}

function bucketLabel(period: Period, start: number): string {
  const d = new Date(start)
  if (period === 'month') return d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })
  if (period === 'week') return 'w/c ' + d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' })
}

/**
 * Activity aggregated into calendar buckets, from our own observation history.
 *
 * Each detection is attributed to the bucket containing the *midpoint* of its
 * uncertainty window — the single most defensible point when all we know is
 * "somewhere between T1 and T2".
 */
export function history(uuid: string, period: Period, count: number, now = Date.now()): HistoryResponse {
  const player = get<{ added_at: number }>('SELECT added_at FROM players WHERE uuid = ?', [uuid])
  const trackingSince = player?.added_at ?? now

  // Walk back `count` buckets from the one containing now.
  const starts: number[] = []
  let cursor = bucketStart(period, now)
  for (let i = 0; i < count; i++) {
    starts.unshift(cursor)
    const prev = new Date(cursor)
    if (period === 'day') prev.setDate(prev.getDate() - 1)
    else if (period === 'week') prev.setDate(prev.getDate() - 7)
    else prev.setMonth(prev.getMonth() - 1)
    cursor = prev.getTime()
  }

  const buckets: HistoryBucket[] = starts.map((start) => ({
    start,
    end: stepBucket(period, start),
    label: bucketLabel(period, start),
    matches: 0,
    per_game: {},
    totals: {},
    tracked: stepBucket(period, start) > trackingSince,
    source: 'observed'
  }))

  const events = all<{ game: string; window_start: number; window_end: number; matches: number; delta: string }>(
    'SELECT game, window_start, window_end, matches, delta FROM activity_events WHERE uuid = ? AND window_end >= ?',
    [uuid, starts[0] ?? now]
  )

  for (const ev of events) {
    const mid = (ev.window_start + ev.window_end) / 2
    const bucket = buckets.find((b) => mid >= b.start && mid < b.end)
    if (!bucket) continue

    bucket.matches += ev.matches
    if (ev.matches > 0) bucket.per_game[ev.game] = (bucket.per_game[ev.game] ?? 0) + ev.matches
    for (const [k, v] of Object.entries(unj<Record<string, number>>(ev.delta, {}))) {
      bucket.totals[k] = (bucket.totals[k] ?? 0) + v
    }
  }

  // Months harvested from the leaderboards beat our own observations: they cover the
  // whole month, including the part before this player joined the watchlist.
  if (period === 'month') {
    for (const bucket of buckets) {
      const d = new Date(bucket.start)
      const rows = all<{ game: string; stats: string }>(
        'SELECT game, stats FROM monthly_stats WHERE uuid = ? AND year = ? AND month = ?',
        [uuid, d.getFullYear(), d.getMonth() + 1]
      )
      if (rows.length === 0) continue

      bucket.per_game = {}
      bucket.totals = {}
      bucket.matches = 0
      bucket.tracked = true
      bucket.source = 'hive'

      for (const r of rows) {
        const stats = unj<Record<string, number>>(r.stats, {})
        const played = stats.played ?? 0
        if (played > 0) bucket.per_game[r.game] = played
        bucket.matches += played
        for (const [k, v] of Object.entries(stats)) bucket.totals[k] = (bucket.totals[k] ?? 0) + v
      }
    }
  }

  const cached = get<{ value: string; fetched_at: number }>('SELECT value, fetched_at FROM meta_cache WHERE key = ?', [
    `monthly:${uuid}`
  ])

  return {
    period,
    tracking_since: trackingSince,
    buckets,
    official_month: cached
      ? { fetched_at: cached.fetched_at, ...unj<{ year: number; month: number; per_game: Record<string, Record<string, number>> }>(cached.value, { year: 0, month: 0, per_game: {} }) }
      : null
  }
}

function deltaSince(uuid: string, gameId: string, since: number): Record<string, number> | null {
  const rows = all<{ delta: string }>(
    'SELECT delta FROM activity_events WHERE uuid = ? AND game = ? AND window_end > ?',
    [uuid, gameId, since]
  )
  if (rows.length === 0) return null
  const out: Record<string, number> = {}
  for (const r of rows) {
    for (const [k, v] of Object.entries(unj<Record<string, number>>(r.delta, {}))) {
      out[k] = (out[k] ?? 0) + v
    }
  }
  return out
}

/** 7 x 24 grid of observed activity minutes, weekday 0 = Monday, local time. */
export function heatmap(uuid: string, days = 60, now = Date.now()): number[][] {
  const grid: number[][] = Array.from({ length: 7 }, () => new Array<number>(24).fill(0))
  const events = all<{ window_start: number; window_end: number; matches: number }>(
    'SELECT window_start, window_end, matches FROM activity_events WHERE uuid = ? AND matches > 0 AND window_end > ?',
    [uuid, now - days * DAY]
  )

  for (const ev of events) {
    // Spread the uncertainty window over the hours it actually spans.
    let cursor = ev.window_start
    while (cursor < ev.window_end) {
      const d = new Date(cursor)
      const weekday = (d.getDay() + 6) % 7 // Monday first
      const hour = d.getHours()
      const endOfHour = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour + 1).getTime()
      const slice = Math.min(endOfHour, ev.window_end) - cursor
      grid[weekday]![hour] = (grid[weekday]![hour] ?? 0) + slice / 60000
      cursor += slice
    }
  }
  return grid
}

export function playerDetail(uuid: string, now = Date.now()): PlayerDetail | null {
  const player = getPlayer(uuid, now)
  if (!player) return null

  const states = all<{
    game: string
    last_observed_at: number
    played: number
    victories: number
    xp: number
    kills: number
    deaths: number
    extra: string
  }>("SELECT * FROM game_state WHERE uuid = ? AND game NOT IN ('main', 'unknown') ORDER BY played DESC", [uuid])

  const games = states.map((s) => {
    const latest: StatPoint = {
      game: s.game,
      observed_at: s.last_observed_at,
      played: s.played,
      victories: s.victories,
      xp: s.xp,
      kills: s.kills,
      deaths: s.deaths,
      extra: unj<Record<string, number>>(s.extra, {})
    }
    return {
      game: s.game,
      latest,
      delta_24h: deltaSince(uuid, s.game, now - DAY),
      delta_7d: deltaSince(uuid, s.game, now - 7 * DAY)
    }
  })

  const sessions = all<{ id: number; started_at: number; ended_at: number; matches: number; games: string }>(
    'SELECT * FROM sessions WHERE uuid = ? ORDER BY ended_at DESC LIMIT 50',
    [uuid]
  ).map<Session>((s) => ({ id: s.id, uuid, started_at: s.started_at, ended_at: s.ended_at, matches: s.matches, games: unj<string[]>(s.games, []) }))

  const events = all<{ id: number; game: string; window_start: number; window_end: number; matches: number; delta: string }>(
    'SELECT id, game, window_start, window_end, matches, delta FROM activity_events WHERE uuid = ? ORDER BY window_end DESC LIMIT 100',
    [uuid]
  ).map<ActivityEvent>((e) => ({
    id: e.id,
    uuid,
    game: e.game,
    window_start: e.window_start,
    window_end: e.window_end,
    matches: e.matches,
    delta: unj<Record<string, number>>(e.delta, {})
  }))

  const raw = get<{ profile: string | null }>('SELECT profile FROM players WHERE uuid = ?', [uuid])

  return {
    player,
    games,
    sessions,
    events,
    heatmap: heatmap(uuid, 60, now),
    profile: raw?.profile ? unj<Record<string, unknown>>(raw.profile, {}) : null
  }
}
