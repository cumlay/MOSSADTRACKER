import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The database path is read when the db module is first imported, so it has to be
// pointed at a throwaway file before anything else loads.
const dir = mkdtempSync(join(tmpdir(), 'ninjatracker-test-'))
process.env.DB_PATH = join(dir, 'test.db')

let db: typeof import('../src/server/db.ts')
let ingest: typeof import('../src/server/tracker/ingest.ts')

const UUID = '00000000-0000-0000-0000-000000000001'
const MINUTE = 60_000

before(async () => {
  db = await import('../src/server/db.ts')
  ingest = await import('../src/server/tracker/ingest.ts')
})

after(() => {
  try {
    db.db.close()
  } catch {
    /* already closed */
  }
  rmSync(dir, { recursive: true, force: true })
})

function addPlayer(uuid = UUID) {
  db.run('DELETE FROM players')
  for (const t of ['activity_events', 'sessions', 'stat_points', 'game_state', 'snapshots']) db.run(`DELETE FROM ${t}`)
  db.run('INSERT INTO players (uuid, username, added_at, tier) VALUES (?, ?, ?, ?)', [uuid, 'tester', 0, 'cold'])
}

const payload = (over: Record<string, number> = {}) => ({
  sky: { UUID, played: 100, victories: 60, xp: 5000, kills: 200, deaths: 50, ...over }
})

test('the first observation is a baseline and reports no activity', () => {
  addPlayer()
  const result = ingest.ingestAll(UUID, payload() as never, 1000)

  assert.equal(result.changed.length, 0, 'nothing to compare against yet')
  assert.equal(db.all('SELECT * FROM activity_events').length, 0)
  assert.equal(db.all('SELECT * FROM game_state').length, 1)
})

test('a played delta becomes an activity event bounded by the two observations', () => {
  addPlayer()
  ingest.ingestAll(UUID, payload() as never, 1000)
  const result = ingest.ingestAll(UUID, payload({ played: 103, victories: 62 }) as never, 1000 + 20 * MINUTE)

  assert.equal(result.changed.length, 1)
  const [event] = result.changed
  assert.equal(event!.game, 'sky')
  assert.equal(event!.matches, 3)
  assert.equal(event!.windowStart, 1000)
  assert.equal(event!.windowEnd, 1000 + 20 * MINUTE)
  assert.equal(event!.delta.victories, 2)
})

test('an unchanged observation still moves the window forward', () => {
  addPlayer()
  ingest.ingestAll(UUID, payload() as never, 1000)
  ingest.ingestAll(UUID, payload() as never, 1000 + 10 * MINUTE) // nothing happened
  const result = ingest.ingestAll(UUID, payload({ played: 101 }) as never, 1000 + 20 * MINUTE)

  // The window must start at the last *observation*, not the last change, otherwise
  // we would claim more uncertainty than we actually have.
  assert.equal(result.changed[0]!.windowStart, 1000 + 10 * MINUTE)
})

test('a counter going backwards is treated as a reset, not as negative activity', () => {
  addPlayer()
  ingest.ingestAll(UUID, payload({ played: 500 }) as never, 1000)
  const result = ingest.ingestAll(UUID, payload({ played: 10 }) as never, 1000 + 20 * MINUTE)

  assert.equal(result.changed.length, 0)
  assert.equal(db.all('SELECT * FROM activity_events').length, 0)
  const state = db.get<{ played: number }>('SELECT played FROM game_state WHERE game = ?', ['sky'])
  assert.equal(state!.played, 10, 're-baselined on the new value')
})

test('detections close together share a session, a distant one opens a new session', () => {
  addPlayer()
  ingest.ingestAll(UUID, payload() as never, 1000)
  const first = ingest.ingestAll(UUID, payload({ played: 102 }) as never, 1000 + 10 * MINUTE)
  const second = ingest.ingestAll(UUID, payload({ played: 104 }) as never, 1000 + 20 * MINUTE)
  const later = ingest.ingestAll(UUID, payload({ played: 106 }) as never, 1000 + 200 * MINUTE)

  assert.equal(first.sessionStarts.length, 1, 'first detection opens a session')
  assert.equal(second.sessionStarts.length, 0, 'ten minutes later is the same session')
  assert.equal(later.sessionStarts.length, 1, 'after a long gap a new session opens')

  const sessions = db.all<{ matches: number }>('SELECT matches FROM sessions ORDER BY started_at')
  assert.equal(sessions.length, 2)
  assert.equal(sessions[0]!.matches, 4, 'two detections of two matches merged')
})

test('retired modes are never ingested', () => {
  addPlayer()
  ingest.ingestAll(UUID, { ...payload(), 'sky-kits': { UUID, played: 5, xp: 5000 } } as never, 1000)
  ingest.ingestAll(UUID, { ...payload(), 'sky-kits': { UUID, played: 5, xp: 5300 } } as never, 1000 + 20 * MINUTE)

  const rows = db.all('SELECT * FROM game_state WHERE game = ?', ['sky-kits'])
  assert.equal(rows.length, 0, 'their mirrored XP used to create phantom detections')
})
