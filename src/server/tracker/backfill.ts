import { all, get, j, run } from '../db.ts'
import { config } from '../config.ts'
import { monthlyLeaderboard } from '../hive/client.ts'
import { globalUsedLastMinute } from '../hive/limiter.ts'

/**
 * Rebuilds months of history from the monthly leaderboards.
 *
 * Those endpoints carry no per-(player, game) limit, and one page covers the top 100
 * players at once — so a single request serves every tracked player who ranks in it,
 * for any month back to 2020. That is history we would otherwise have to wait months
 * to accumulate ourselves, at zero cost to the per-player budget.
 *
 * Players outside the top 100 simply have no row; the UI must not read that as "did
 * not play".
 */

const DEFAULT_MONTHS = 6
/** Leave headroom under the global cap so live tracking is never starved. */
const GLOBAL_HEADROOM = 25

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function monthsBack(count: number, now = Date.now()): Array<{ year: number; month: number }> {
  const out: Array<{ year: number; month: number }> = []
  const d = new Date(now)
  for (let i = 0; i < count; i++) {
    out.push({ year: d.getFullYear(), month: d.getMonth() + 1 })
    d.setMonth(d.getMonth() - 1)
  }
  return out
}

export interface BackfillReport {
  requests: number
  rows: number
  games: string[]
  months: number
  skipped: number
}

export async function backfillMonthly(months = DEFAULT_MONTHS, now = Date.now()): Promise<BackfillReport> {
  const tracked = new Map(
    all<{ uuid: string }>('SELECT uuid FROM players').map((p) => [p.uuid.toLowerCase(), p.uuid])
  )
  if (tracked.size === 0) return { requests: 0, rows: 0, games: [], months, skipped: 0 }

  // Only scan the games our watchlist actually plays.
  const games = all<{ game: string }>(
    `SELECT game FROM game_state
     WHERE played > 0 AND game NOT IN ('main', 'unknown')
     GROUP BY game ORDER BY SUM(played) DESC`
  ).map((r) => r.game)

  const report: BackfillReport = { requests: 0, rows: 0, games, months, skipped: 0 }
  const current = monthsBack(1, now)[0]!

  for (const game of games) {
    for (const { year, month } of monthsBack(months, now)) {
      const isCurrent = year === current.year && month === current.month
      // A finished month never changes, so it is fetched once and kept.
      if (!isCurrent && hasMonth(game, year, month)) {
        report.skipped++
        continue
      }

      while (globalUsedLastMinute() >= config.hive.globalPerMinute - GLOBAL_HEADROOM) await sleep(3000)

      const res = await monthlyLeaderboard(game, year, month)
      report.requests++
      if (!res.ok) continue

      for (const row of res.data) {
        const uuid = tracked.get(String(row.UUID ?? '').toLowerCase())
        if (!uuid) continue

        const stats: Record<string, number> = {}
        for (const [k, v] of Object.entries(row)) {
          if (typeof v === 'number' && k !== 'index' && k !== 'human_index') stats[k] = v
        }

        run(
          `INSERT INTO monthly_stats (uuid, game, year, month, rank, stats, fetched_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(uuid, game, year, month) DO UPDATE SET
             rank = excluded.rank, stats = excluded.stats, fetched_at = excluded.fetched_at`,
          [uuid, game, year, month, Number(row.human_index ?? 0) || null, j(stats), now]
        )
        report.rows++
      }

      await sleep(400)
    }
  }

  run(
    `INSERT INTO settings (key, value) VALUES ('backfill_last_run', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [String(now)]
  )
  return report
}

function hasMonth(game: string, year: number, month: number): boolean {
  return (
    (get<{ n: number }>('SELECT COUNT(*) AS n FROM monthly_stats WHERE game = ? AND year = ? AND month = ?', [
      game,
      year,
      month
    ])?.n ?? 0) > 0
  )
}

/** Runs the backfill at most once a day, in the background. */
export function scheduleBackfill(now = Date.now()): void {
  const last = Number(get<{ value: string }>("SELECT value FROM settings WHERE key = 'backfill_last_run'")?.value ?? 0)
  if (now - last < 24 * 60 * 60 * 1000) return

  setTimeout(() => {
    backfillMonthly()
      .then((r) => console.log(`[backfill] ${r.requests} requests, ${r.rows} monthly rows, ${r.skipped} already known`))
      .catch((err) => console.error('[backfill] failed', err))
  }, 5000)
}
