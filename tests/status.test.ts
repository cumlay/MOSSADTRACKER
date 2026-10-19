import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'ninjatracker-status-'))
process.env.DB_PATH = join(dir, 'test.db')

let db: typeof import('../src/server/db.ts')
let ingest: typeof import('../src/server/tracker/ingest.ts')
let queries: typeof import('../src/server/queries.ts')

const UUID = '00000000-0000-0000-0000-0000000000aa'
const MINUTE = 60_000
const HOUR = 60 * MINUTE

before(async () => {
  db = await import('../src/server/db.ts')
  ingest = await import('../src/server/tracker/ingest.ts')
  queries = await import('../src/server/queries.ts')
})

after(() => {
  try {
    db.db.close()
  } catch {
    /* already closed */
  }
  rmSync(dir, { recursive: true, force: true })
})

function reset() {
  db.run('DELETE FROM players')
  for (const t of ['activity_events', 'sessions', 'stat_points', 'game_state', 'snapshots']) db.run(`DELETE FROM ${t}`)
  db.run('INSERT INTO players (uuid, username, added_at, tier) VALUES (?, ?, ?, ?)', [UUID, 'tester', 0, 'cold'])
}

const payload = (played: number) => ({ sky: { UUID, played, victories: 0, xp: 0, kills: 0, deaths: 0 } })

test('a tight detection puts the player just behind now', () => {
  reset()
  const now = Date.now()
  ingest.ingestAll(UUID, payload(100) as never, now - 8 * MINUTE)
  ingest.ingestAll(UUID, payload(102) as never, now)

  const player = queries.getPlayer(UUID, now)!
  assert.equal(player.status, 'live')
  // Midpoint of an 8-minute window: four minutes back, not "right now".
  assert.ok(Math.abs(now - player.last_seen_at! - 4 * MINUTE) < 1000)
})

test('a detection window spanning tracker downtime never claims the player is live', () => {
  reset()
  const now = Date.now()
  // Observed a week ago, then the tracker stopped and only came back just now.
  ingest.ingestAll(UUID, payload(100) as never, now - 168 * HOUR)
  ingest.ingestAll(UUID, payload(350) as never, now)

  const player = queries.getPlayer(UUID, now)!
  assert.notEqual(player.status, 'live', 'we know that they played, not when')
  assert.ok(player.last_seen_window_ms! > 100 * HOUR, 'the uncertainty is carried alongside')
  // The estimate lands in the middle of the gap rather than at its edge.
  assert.ok(now - player.last_seen_at! > 80 * HOUR)
})
