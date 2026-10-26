import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mossadtracker-features-'))
process.env.DB_PATH = join(dir, 'test.db')
// No bot token: sweeps run without waiting for a Discord login.
delete process.env.DISCORD_TOKEN

let db: typeof import('../src/server/db.ts')
let ingest: typeof import('../src/server/tracker/ingest.ts')
let notifier: typeof import('../src/server/notifier.ts')
let alerts: typeof import('../src/server/alerts.ts')
let insights: typeof import('../src/server/insights.ts')
let settings: typeof import('../src/server/settings.ts')
let players: typeof import('../src/server/services/players.ts')
let organise: typeof import('../src/server/services/organise.ts')
let audit: typeof import('../src/server/audit.ts')

const A = 'aaaaaaaa-0000-0000-0000-000000000001'
const B = 'bbbbbbbb-0000-0000-0000-000000000002'
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const STAFF = { name: 'staff', source: 'web', access: 'full' } as const

let posted: Array<{ title: string; channel: string | null }> = []

before(async () => {
  db = await import('../src/server/db.ts')
  ingest = await import('../src/server/tracker/ingest.ts')
  notifier = await import('../src/server/notifier.ts')
  alerts = await import('../src/server/alerts.ts')
  insights = await import('../src/server/insights.ts')
  settings = await import('../src/server/settings.ts')
  players = await import('../src/server/services/players.ts')
  organise = await import('../src/server/services/organise.ts')
  audit = await import('../src/server/audit.ts')
})

after(() => {
  notifier.setAlertSink(null)
  try {
    db.db.close()
  } catch {
    /* already closed */
  }
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  for (const t of ['players', 'activity_events', 'sessions', 'stat_points', 'game_state', 'snapshots', 'player_notes', 'player_groups', 'audit_log', 'settings']) {
    db.run(`DELETE FROM ${t}`)
  }
  posted = []
  notifier.setAlertSink(async (embed, channel) => {
    posted.push({ title: embed.title, channel })
    return true
  })
})

function addPlayer(uuid: string, name: string, addedAt = Date.now(), addedBy: string | null = null) {
  db.run('INSERT INTO players (uuid, username, username_cc, added_at, tier, added_by) VALUES (?, ?, ?, ?, ?, ?)', [uuid, name, name, addedAt, 'cold', addedBy])
}

const bed = (uuid: string, played: number, victories: number, xp = 1000) => ({ bed: { UUID: uuid, played, victories, xp, kills: 0, deaths: 0 } })

/* ------------------------------------------------------------------ streaks */

test('win streak grows on all-win batches, resets on any loss, best is kept', () => {
  addPlayer(A, 'alpha')
  const t0 = Date.now() - 3 * HOUR
  ingest.ingestAll(A, bed(A, 10, 5), t0)
  const r1 = ingest.ingestAll(A, bed(A, 13, 8), t0 + 10 * MIN)
  assert.deepEqual(r1.changed[0]!.streak, { before: 0, after: 3 })
  const r2 = ingest.ingestAll(A, bed(A, 16, 11), t0 + 20 * MIN)
  assert.deepEqual(r2.changed[0]!.streak, { before: 3, after: 6 })
  const r3 = ingest.ingestAll(A, bed(A, 18, 12), t0 + 30 * MIN)
  assert.deepEqual(r3.changed[0]!.streak, { before: 6, after: 0 })
  const row = db.get<{ win_streak: number; best_streak: number }>('SELECT win_streak, best_streak FROM game_state WHERE uuid = ?', [A])
  assert.deepEqual(row, { win_streak: 0, best_streak: 6 })
})

test('a streak crossing 5 posts a milestone; level-ups only on every 5th level', async () => {
  addPlayer(A, 'alpha')
  // A fake level curve in the cache: level n+1 at n*100 XP, cap 50.
  const curve = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [String(i * 100), i]))
  db.run('INSERT INTO meta_cache (key, value, fetched_at) VALUES (?, ?, ?)', [
    'meta:bed',
    JSON.stringify({ maxLevel: 50, allowPrestiging: false, maxPrestige: 0, experienceToLevel: curve }),
    Date.now()
  ])

  const t0 = Date.now() - 2 * HOUR
  ingest.ingestAll(A, bed(A, 10, 5, 250), t0) // level 3
  const r = ingest.ingestAll(A, bed(A, 15, 10, 420), t0 + 10 * MIN) // 5 straight wins, level 5
  await alerts.milestones(A, r.changed)
  assert.deepEqual(posted.map((p) => p.title), ['⬆️ alpha — BedWars', '🔥 alpha — BedWars'])

  posted = []
  const r2 = ingest.ingestAll(A, bed(A, 16, 10, 520), t0 + 20 * MIN) // level 6, loss
  await alerts.milestones(A, r2.changed)
  assert.equal(posted.length, 0)
})

/* ------------------------------------------------------- session summaries */

test('a finished session is summarised once, with companions', async () => {
  addPlayer(A, 'alpha')
  addPlayer(B, 'bravo')
  const t0 = Date.now() - 2 * HOUR
  for (const uuid of [A, B]) {
    ingest.ingestAll(uuid, bed(uuid, 10, 5), t0)
    ingest.ingestAll(uuid, bed(uuid, 12, 6), t0 + 10 * MIN)
  }

  assert.equal(await alerts.sweepSessions(), 2)
  assert.deepEqual(posted.map((p) => p.title).sort(), ['⚫ alpha stopped playing', '⚫ bravo stopped playing'])
  const summary = await insights.sessionSummary(db.get<{ id: number }>('SELECT id FROM sessions WHERE uuid = ?', [A])!.id)
  assert.deepEqual(summary!.with, ['bravo'])
  assert.equal(summary!.games[0]!.matches, 2)

  posted = []
  assert.equal(await alerts.sweepSessions(), 0, 'never twice')
})

test('summaries respect the mute and the setting, but still mark the session', async () => {
  addPlayer(A, 'alpha')
  const t0 = Date.now() - 2 * HOUR
  ingest.ingestAll(A, bed(A, 10, 5), t0)
  ingest.ingestAll(A, bed(A, 12, 6), t0 + 10 * MIN)
  settings.saveBotSettings({ session_end: false })

  assert.equal(await alerts.sweepSessions(), 0)
  settings.saveBotSettings({ session_end: true })
  assert.equal(await alerts.sweepSessions(), 0, 'already marked while the setting was off')
})

/* -------------------------------------------------------------- inactivity */

test('inactivity is announced once and re-armed when they play again', async () => {
  addPlayer(A, 'alpha', Date.now() - 30 * DAY)
  db.run('UPDATE players SET last_seen_at = ? WHERE uuid = ?', [Date.now() - 10 * DAY, A])

  assert.equal(await alerts.sweepInactivity(), 1)
  assert.match(posted[0]!.title, /alpha has gone quiet/)
  assert.equal(await alerts.sweepInactivity(), 0)

  const t0 = Date.now() - 20 * MIN
  ingest.ingestAll(A, bed(A, 10, 5), t0)
  ingest.ingestAll(A, bed(A, 11, 5), t0 + 10 * MIN)
  assert.equal(db.get<{ f: number }>('SELECT inactive_notified AS f FROM players WHERE uuid = ?', [A])!.f, 0)
})

test('a dormant tier follows the inactivity threshold', () => {
  addPlayer(A, 'alpha', Date.now() - 10 * DAY)
  ingest.refreshPlayerState(A)
  assert.equal(db.get<{ tier: string }>('SELECT tier FROM players WHERE uuid = ?', [A])!.tier, 'dormant')
  settings.saveBotSettings({ inactive_days: 14 })
  ingest.refreshPlayerState(A)
  assert.equal(db.get<{ tier: string }>('SELECT tier FROM players WHERE uuid = ?', [A])!.tier, 'cold')
})

/* ------------------------------------------------------------ insights */

test('usual hours: the smallest window holding most of the play', () => {
  const grid = Array.from({ length: 7 }, () => new Array<number>(24).fill(0))
  for (const d of [4, 5]) for (const h of [20, 21, 22]) grid[d]![h] = 40
  grid[1]![9] = 10
  const t = insights.typicalFromGrid(grid)!
  assert.equal(t.from, 20)
  assert.equal(t.to, 23)
  assert.ok(t.share > 0.9)
  assert.deepEqual(t.days.sort(), [4, 5])
  assert.equal(insights.typicalFromGrid(Array.from({ length: 7 }, () => new Array<number>(24).fill(0))), null)
})

test('played-with counts overlapping sessions on a shared game only', () => {
  addPlayer(A, 'alpha')
  addPlayer(B, 'bravo')
  const now = Date.now()
  const ins = (uuid: string, s: number, e: number, games: string[]) =>
    db.run('INSERT INTO sessions (uuid, started_at, ended_at, matches, games, summary_sent) VALUES (?, ?, ?, 3, ?, 1)', [uuid, s, e, JSON.stringify(games)])
  ins(A, now - 5 * HOUR, now - 4 * HOUR, ['bed'])
  ins(B, now - 4.5 * HOUR, now - 3 * HOUR, ['bed', 'sky'])
  ins(A, now - 2 * HOUR, now - HOUR, ['sky'])
  ins(B, now - 2 * HOUR, now - HOUR, ['wars'])

  const mates = insights.playedWith(A, 60, now)
  assert.equal(mates.length, 1)
  assert.equal(mates[0]!.username, 'bravo')
  assert.equal(mates[0]!.sessions, 1)
  assert.deepEqual(mates[0]!.games, ['bed'])
})

test('CSV export neutralises spreadsheet formulas', () => {
  addPlayer(A, 'alpha')
  db.run("INSERT INTO sessions (uuid, started_at, ended_at, matches, games, summary_sent) VALUES (?, 0, 600000, 2, ?, 1)", [A, '["=cmd"]'])
  const csv = insights.sessionsCsv(A)
  assert.match(csv, /^started_at,ended_at,duration_min,matches,games\r\n/)
  assert.match(csv, /,'=cmd\r\n$/)
})

test('report: most active, longest session', async () => {
  addPlayer(A, 'alpha')
  addPlayer(B, 'bravo')
  const t0 = Date.now() - 3 * HOUR
  ingest.ingestAll(A, bed(A, 10, 5), t0)
  ingest.ingestAll(A, bed(A, 14, 6), t0 + 10 * MIN)
  ingest.ingestAll(B, bed(B, 10, 5), t0)
  ingest.ingestAll(B, bed(B, 11, 5), t0 + 10 * MIN)
  const r = await insights.buildReport(t0 - HOUR, Date.now())
  assert.equal(r.matches, 5)
  assert.equal(r.active, 2)
  assert.deepEqual(r.top.map((p) => p.name), ['alpha', 'bravo'])
  assert.equal(r.top_game!.game, 'bed')
  assert.ok(r.longest)
})

/* ---------------------------------------------------- limits, groups, audit */

test('a limited account cannot exceed its add limit (refused before any Hive call)', async () => {
  settings.saveBotSettings({ user_add_limit: 1 })
  addPlayer(A, 'alpha', Date.now(), 'bob')
  const res = await players.trackPlayer('someone', { name: 'bob', source: 'web', access: 'user' })
  assert.deepEqual(res, { ok: false, reason: 'limit', limit: 1 })
  assert.equal(players.addLimit({ name: 'x', source: 'web', access: 'full' }), null)
})

test('group alerts go to the group channel; others to the default', async () => {
  addPlayer(A, 'alpha')
  addPlayer(B, 'bravo')
  const g = organise.createGroup({ name: 'Clan X', color: '#ff0000', channel_id: '123456789012345678' }, STAFF)
  organise.setGroup(A, g.id, STAFF)

  await notifier.postAlert({ title: 'a', color: 0 }, A)
  await notifier.postAlert({ title: 'b', color: 0 }, B)
  assert.deepEqual(posted, [
    { title: 'a', channel: '123456789012345678' },
    { title: 'b', channel: null }
  ])

  assert.throws(() => organise.createGroup({ name: 'clan x' }, STAFF), /exists/)
  assert.throws(() => organise.updateGroup(g.id, { channel_id: 'general' }, STAFF), /channel ID/)
  organise.deleteGroup(g.id, STAFF)
  assert.equal(db.get<{ g: number | null }>('SELECT group_id AS g FROM players WHERE uuid = ?', [A])!.g, null)
})

test('tags and notes are validated and every change lands in the audit log', () => {
  addPlayer(A, 'alpha')
  organise.setTags(A, ['main', 'cheater?', 'main'], STAFF)
  assert.deepEqual(JSON.parse(db.get<{ tags: string }>('SELECT tags FROM players WHERE uuid = ?', [A])!.tags), ['main', 'cheater?'])
  assert.throws(() => organise.setTags(A, ['<script>'], STAFF), /invalid tag/)
  assert.throws(() => organise.setTags(A, 'main', STAFF), /list/)

  const note = organise.addNote(A, '  alt of bravo  ', STAFF)!
  assert.equal(note.body, 'alt of bravo')
  assert.throws(() => organise.addNote(A, '', STAFF))
  organise.deleteNote(A, note.id, STAFF)
  players.setPlayerFlags(A, { notify: false }, STAFF)
  players.untrackPlayer(A, { name: 'boss', source: 'discord', access: 'full' })

  const log = audit.auditLog()
  assert.deepEqual(log.map((e) => e.action), ['untrack', 'alerts off', 'note delete', 'note', 'tags'])
  assert.equal(log[0]!.actor, 'boss')
  assert.equal(log[0]!.source, 'discord')
  assert.equal(log[0]!.target_name, 'alpha')
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM player_notes')!.n, 0, 'notes go with the player')
})

test('settings are clamped and unknown keys ignored', () => {
  const s = settings.saveBotSettings({ report_hour: 99, inactive_days: 0, user_add_limit: '7', session_end: 'yes', evil: 1 })
  assert.equal(s.report_hour, 23)
  assert.equal(s.inactive_days, 2)
  assert.equal(s.user_add_limit, 7)
  assert.equal(s.session_end, true)
  assert.equal((s as unknown as Record<string, unknown>).evil, undefined)
})
