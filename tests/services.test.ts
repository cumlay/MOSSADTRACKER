import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mossadtracker-svc-'))
process.env.DB_PATH = join(dir, 'test.db')

let db: typeof import('../src/server/db.ts')
let players: typeof import('../src/server/services/players.ts')

before(async () => {
  db = await import('../src/server/db.ts')
  players = await import('../src/server/services/players.ts')

  db.run('DELETE FROM players')
  const add = (uuid: string, username: string, cased: string) =>
    db.run('INSERT INTO players (uuid, username, username_cc, added_at, tier) VALUES (?, ?, ?, ?, ?)', [
      uuid,
      username,
      cased,
      0,
      'cold'
    ])

  add('11111111-1111-1111-1111-111111111111', 'tuff corlay', 'tuff corlay')
  add('22222222-2222-2222-2222-222222222222', 'lizqfx', 'Lizqfx')
  add('33333333-3333-3333-3333-333333333333', 'lizqww', 'lizqww')
})

after(() => {
  try {
    db.db.close()
  } catch {
    /* already closed */
  }
  rmSync(dir, { recursive: true, force: true })
})

test('finds a tracked player by exact name, whatever the casing', () => {
  assert.equal(players.findTracked('tuff corlay')?.username, 'tuff corlay')
  assert.equal(players.findTracked('LIZQFX')?.username, 'lizqfx')
  assert.equal(players.findTracked('Lizqfx')?.username, 'lizqfx')
})

test('finds a player by UUID', () => {
  assert.equal(players.findTracked('11111111-1111-1111-1111-111111111111')?.username, 'tuff corlay')
})

test('accepts an unambiguous partial name', () => {
  assert.equal(players.findTracked('corlay')?.username, 'tuff corlay')
})

test('refuses an ambiguous partial rather than removing the wrong player', () => {
  // "lizq" matches both lizqfx and lizqww — deleting either would be a silent mistake.
  assert.equal(players.findTracked('lizq'), null)
})

test('returns nothing for an unknown player', () => {
  assert.equal(players.findTracked('nobody'), null)
})

test('untracking removes the player and their derived rows', () => {
  const uuid = '22222222-2222-2222-2222-222222222222'
  db.run('INSERT INTO activity_events (uuid, game, window_start, window_end, matches) VALUES (?, ?, ?, ?, ?)', [
    uuid,
    'sky',
    0,
    1,
    2
  ])

  players.untrackPlayer(uuid)

  assert.equal(players.findTracked('Lizqfx'), null)
  assert.equal(db.all('SELECT * FROM activity_events WHERE uuid = ?', [uuid]).length, 0)
})
