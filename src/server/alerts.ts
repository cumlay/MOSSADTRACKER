import { config } from './config.ts'
import { all, get, run } from './db.ts'
import { hasAlertSink, postAlert } from './notifier.ts'
import { buildReport, levelChange, sessionSummary } from './insights.ts'
import { getBotSettings, getMark, setMark } from './settings.ts'
import { inactiveEmbed, milestoneEmbed, reportEmbed, sessionEndEmbed } from './embeds.ts'
import type { ObservedChange } from './tracker/ingest.ts'

/**
 * Everything the bot posts besides "X is online": session summaries, milestones,
 * inactivity notices and the daily/weekly reports.
 *
 * Each event is marked as handled whether or not it was posted, so switching an alert
 * type on later never floods the channel with old news.
 */

const DAY = 24 * 60 * 60 * 1000
/** A summary for a session that ended longer ago than this (tracker was down) is skipped. */
const STALE_SUMMARY_MS = 6 * 60 * 60 * 1000
/** More inactivity notices than this in one sweep are marked silently instead of flooding. */
const MAX_INACTIVE_POSTS = 5

/**
 * The bot logs in a few seconds after boot: until then, leave events unhandled rather
 * than marking them and losing them. Without a token there is no bot to wait for.
 */
const waitingForBot = () => !hasAlertSink() && !!process.env.DISCORD_TOKEN

function player(uuid: string) {
  return get<{ name: string; notify: number; last_seen_at: number | null; last_game: string | null }>(
    'SELECT COALESCE(username_cc, username) AS name, notify, last_seen_at, last_game FROM players WHERE uuid = ?',
    [uuid]
  )
}

/* -------------------------------------------------------------- milestones */

/** Every 5th level, the level cap, any prestige, and win streaks of 5, 10, 15… */
export async function milestones(uuid: string, changes: ObservedChange[]): Promise<number> {
  if (!hasAlertSink() || !getBotSettings().milestones) return 0
  const p = player(uuid)
  if (!p || p.notify === 0) return 0

  let posted = 0
  for (const ev of changes) {
    const prestige = ev.delta.prestige ?? 0
    if (prestige > 0) {
      posted += +(await postAlert(milestoneEmbed(p.name, ev.game, 'Prestiged! The level counter starts again.', '⭐'), uuid))
    } else if (ev.xp !== undefined && (ev.delta.xp ?? 0) > 0) {
      const change = await levelChange(ev.game, ev.xp, ev.delta.xp!)
      if (change && change.to > change.from && (Math.floor(change.to / 5) > Math.floor(change.from / 5) || change.max)) {
        const text = change.max ? `Reached the **maximum level, ${change.to}**.` : `Reached **level ${change.to}**.`
        posted += +(await postAlert(milestoneEmbed(p.name, ev.game, text, '⬆️'), uuid))
      }
    }
    if (ev.streak && ev.streak.after >= 5 && Math.floor(ev.streak.after / 5) > Math.floor(ev.streak.before / 5)) {
      posted += +(await postAlert(milestoneEmbed(p.name, ev.game, `**${ev.streak.after} wins in a row.**`, '🔥'), uuid))
    }
  }
  return posted
}

/* -------------------------------------------------------- session summaries */

/** Sessions with no activity for longer than the session gap are over. */
export async function sweepSessions(now = Date.now()): Promise<number> {
  if (waitingForBot()) return 0
  const closed = all<{ id: number; uuid: string; ended_at: number; matches: number }>(
    'SELECT id, uuid, ended_at, matches FROM sessions WHERE summary_sent = 0 AND ended_at < ?',
    [now - config.scheduler.sessionGapMs]
  )
  const enabled = hasAlertSink() && getBotSettings().session_end
  let posted = 0

  for (const s of closed) {
    run('UPDATE sessions SET summary_sent = 1 WHERE id = ?', [s.id])
    if (!enabled || s.matches <= 0 || now - s.ended_at > STALE_SUMMARY_MS) continue
    if (player(s.uuid)?.notify === 0) continue
    const summary = await sessionSummary(s.id)
    if (summary) posted += +(await postAlert(sessionEndEmbed(summary), s.uuid))
  }
  return posted
}

/* -------------------------------------------------------------- inactivity */

export async function sweepInactivity(now = Date.now()): Promise<number> {
  if (waitingForBot()) return 0
  const settings = getBotSettings()
  const rows = all<{ uuid: string }>(
    'SELECT uuid FROM players WHERE enabled = 1 AND inactive_notified = 0 AND COALESCE(last_seen_at, added_at) < ?',
    [now - settings.inactive_days * DAY]
  )
  const enabled = hasAlertSink() && settings.inactivity
  let posted = 0

  for (const { uuid } of rows) {
    run('UPDATE players SET inactive_notified = 1 WHERE uuid = ?', [uuid])
    const p = player(uuid)
    if (!enabled || !p || p.notify === 0 || rows.length > MAX_INACTIVE_POSTS) continue
    posted += +(await postAlert(inactiveEmbed(p.name, p.last_seen_at, p.last_game, settings.inactive_days), uuid))
  }
  return posted
}

/* ----------------------------------------------------------------- reports */

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
const startOfDay = (ts: number) => {
  const d = new Date(ts)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** Daily report for yesterday and, on Mondays, a weekly one for last week — once each. */
export async function sweepReports(now = Date.now()): Promise<number> {
  if (!hasAlertSink()) return 0
  const settings = getBotSettings()
  const local = new Date(now)
  if (local.getHours() < settings.report_hour) return 0

  const today = startOfDay(now)
  let posted = 0

  if (settings.daily_report && getMark('daily') !== dayKey(local)) {
    setMark('daily', dayKey(local))
    const from = startOfDay(today - DAY / 2)
    posted += +(await postAlert(reportEmbed(await buildReport(from, today), `📊 Daily report — ${new Date(from).toDateString()}`)))
  }

  // getDay() 1 = Monday: the week that just ended runs Monday to Monday.
  if (settings.weekly_report && local.getDay() === 1 && getMark('weekly') !== dayKey(local)) {
    setMark('weekly', dayKey(local))
    const from = startOfDay(today - 6.5 * DAY)
    posted += +(await postAlert(reportEmbed(await buildReport(from, today), '🗓️ Weekly report')))
  }
  return posted
}

/* -------------------------------------------------------------------- loop */

let timer: NodeJS.Timeout | null = null
let busy = false

export function startAlertLoop(): void {
  if (timer) return
  const tick = async () => {
    if (busy) return
    busy = true
    try {
      const now = Date.now()
      await sweepSessions(now)
      await sweepInactivity(now)
      await sweepReports(now)
    } catch (err) {
      console.error('[alerts] sweep failed', err)
    } finally {
      busy = false
    }
  }
  timer = setInterval(() => void tick(), 60_000)
  void tick()
}
