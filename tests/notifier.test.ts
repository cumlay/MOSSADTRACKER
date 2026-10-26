import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mossadtracker-notify-'))
process.env.DB_PATH = join(dir, 'test.db')

let db: typeof import('../src/server/db.ts')
let notifier: typeof import('../src/server/notifier.ts')

const UUID = '44444444-4444-4444-4444-444444444444'
const alert = { uuid: UUID, gameId: 'wars', matches: 2, windowStart: 1_700_000_000_000, windowEnd: 1_700_000_420_000 }

before(async () => {
  db = await import('../src/server/db.ts')
  notifier = await import('../src/server/notifier.ts')
  db.run('INSERT INTO players (uuid, username, username_cc, added_at, tier) VALUES (?, ?, ?, ?, ?)', [
    UUID,
    'tuff corlay',
    'tuff corlay',
    0,
    'cold'
  ])
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

test('session start reaches the bot without a webhook configured', async () => {
  const sent: import('../src/server/notifier.ts').AlertEmbed[] = []
  notifier.setAlertSink(async (embed) => {
    sent.push(embed)
    return true
  })

  assert.equal(await notifier.notifySessionStart(alert), true)
  assert.equal(sent.length, 1)
  assert.match(sent[0]!.title, /tuff corlay is online/)
  assert.equal(sent[0]!.fields!.find((f) => f.name === 'Matches')?.value, '2')
  // Discord timestamp markup, rendered in each reader's timezone
  assert.match(sent[0]!.fields!.find((f) => f.name === 'Seen')!.value, /<t:1700000000:t>/)
})

test('a muted player sends nothing', async () => {
  let calls = 0
  notifier.setAlertSink(async () => (calls++, true))
  db.run('UPDATE players SET notify = 0 WHERE uuid = ?', [UUID])

  assert.equal(await notifier.notifySessionStart(alert), false)
  assert.equal(calls, 0)
  db.run('UPDATE players SET notify = 1 WHERE uuid = ?', [UUID])
})

test('the game filter applies to the bot too', async () => {
  let calls = 0
  notifier.setAlertSink(async () => (calls++, true))
  notifier.saveSettings({ games: ['bed'] })

  assert.equal(await notifier.notifySessionStart(alert), false)
  assert.equal(calls, 0)
  notifier.saveSettings({ games: [] })
})
