import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'tracker-sightings-'))
process.env.DB_PATH = join(dir, 'test.db')

let db: typeof import('../src/server/db.ts')
let sightings: typeof import('../src/server/sightings.ts')
let queries: typeof import('../src/server/queries.ts')
let notifier: typeof import('../src/server/notifier.ts')

const UUID = '00000000-0000-0000-0000-0000000000cc'
const OTHER = '00000000-0000-0000-0000-0000000000dd'
const MINUTE = 60_000

let posted: string[] = []

before(async () => {
  db = await import('../src/server/db.ts')
  sightings = await import('../src/server/sightings.ts')
  queries = await import('../src/server/queries.ts')
  notifier = await import('../src/server/notifier.ts')
  // Capture alerts instead of sending them.
  notifier.setAlertSink(async (embed) => {
    posted.push(embed.title)
    return true
  })
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
  posted = []
  for (const t of ['players', 'sightings', 'activity_events', 'sessions', 'game_state', 'stat_points']) db.run(`DELETE FROM ${t}`)
  db.run('INSERT INTO players (uuid, username, username_cc, added_at, tier) VALUES (?, ?, ?, ?, ?)', [
    UUID,
    'target',
    'Target',
    0,
    'cold'
  ])
})

test('the roster only carries what the client needs to match a lobby', () => {
  const list = sightings.roster()
  assert.equal(list.length, 1)
  assert.deepEqual(Object.keys(list[0]!).sort(), ['name', 'uuid'])
  assert.equal(list[0]!.name, 'Target', 'the cased gamertag, as the player list shows it')
})

test('an untracked player in the lobby is ignored', async () => {
  const r = await sightings.recordSightings([{ name: 'Stranger' }, { uuid: OTHER }], { server: 'BED-DUOS12' })
  assert.equal(r.matched, 0)
  assert.equal(r.recorded, 0)
  assert.equal(posted.length, 0)
})

test('a tracked player is matched case-insensitively and alerted once', async () => {
  const now = Date.now()
  const first = await sightings.recordSightings([{ name: 'TARGET' }], { server: 'BED-DUOS12', game: 'bed' }, now)
  assert.equal(first.recorded, 1)
  assert.deepEqual(first.names, ['Target'])
  assert.equal(posted.length, 1)

  // The client reports the same lobby every few seconds: that is not news.
  const again = await sightings.recordSightings([{ name: 'Target' }], { server: 'BED-DUOS12', game: 'bed' }, now + 30_000)
  assert.equal(again.matched, 1)
  assert.equal(again.recorded, 0, 'inside the dedupe window')
  assert.equal(posted.length, 1, 'and no second ping')
})

test('moving to another server is news straight away', async () => {
  const now = Date.now()
  await sightings.recordSightings([{ name: 'Target' }], { server: 'BED-DUOS12' }, now)
  const moved = await sightings.recordSightings([{ name: 'Target' }], { server: 'SKY-SOLO3' }, now + 20_000)

  assert.equal(moved.recorded, 1)
  assert.equal(posted.length, 2)
})

test('a sighting makes the player live with no uncertainty', async () => {
  const now = Date.now()
  await sightings.recordSightings([{ name: 'Target' }], { server: 'BED-DUOS12', game: 'bed' }, now)

  const player = queries.getPlayer(UUID, now)!
  assert.equal(player.status, 'live')
  assert.equal(player.last_seen_window_ms, 0, 'we watched them stand there; there is nothing to estimate')
  assert.equal(player.last_seen_at, now)
  assert.ok(player.in_lobby, 'and the watchlist can show the badge')
  assert.equal(player.in_lobby!.server, 'BED-DUOS12')
})

test('a sighting never invents matches played', async () => {
  const now = Date.now()
  await sightings.recordSightings([{ name: 'Target' }], { server: 'BED-DUOS12', game: 'bed' }, now)

  const player = queries.getPlayer(UUID, now)!
  assert.equal(player.matches_24h, 0, 'standing in a lobby is not a finished match')
  assert.equal(player.last_game, null, 'and says nothing about what they last played')
})

test('the lobby badge goes out on its own', async () => {
  const now = Date.now()
  await sightings.recordSightings([{ name: 'Target' }], { server: 'BED-DUOS12' }, now)

  assert.ok(queries.getPlayer(UUID, now)!.in_lobby)
  assert.equal(queries.getPlayer(UUID, now + 10 * MINUTE)!.in_lobby, null)
})
