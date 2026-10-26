import { test } from 'node:test'
import assert from 'node:assert/strict'
import { commands, gameChoices, searchChoices, trackedChoices, WRITE_COMMANDS } from '../src/server/bot/commands.ts'
import type { PlayerRow } from '../src/shared/types.ts'

const NOW = 1_700_000_000_000

const row = (uuid: string, username: string, extra: Partial<PlayerRow> = {}): PlayerRow =>
  ({
    uuid,
    username,
    username_cc: username,
    status: 'cold',
    notify: 1,
    enabled: 1,
    last_seen_at: null,
    last_game: null,
    ...extra
  }) as PlayerRow

test('every command is valid for Discord; access is checked by the bot, not by Discord defaults', () => {
  const names = commands.map((c) => c.name)
  assert.deepEqual(names, ['track', 'untrack', 'alerts', 'watchlist', 'online', 'stats', 'sessions', 'compare', 'report', 'link', 'unlink'])
  for (const c of commands) {
    assert.match(c.name, /^[a-z-]{1,32}$/)
    assert.ok(c.description.length <= 100, c.name)
    // Linked tracker users without Manage Server must be able to see /track.
    assert.equal(c.default_member_permissions ?? null, null, c.name)
  }
  assert.deepEqual(WRITE_COMMANDS, { track: 'user', untrack: 'full', alerts: 'full' })
})

test('game suggestions follow what the player actually played', () => {
  const played = [
    { game: 'bed', played: 120 },
    { game: 'sky', played: 30 },
    { game: 'parkour', played: 4 }
  ]
  const all = gameChoices(played, '')
  assert.deepEqual(all.map((c) => c.value), ['bed', 'sky'])
  assert.equal(all[0]!.name, 'BedWars · 120 played')
  assert.deepEqual(gameChoices(played, 'sky').map((c) => c.value), ['sky'])
  // No player picked yet: every game is offered.
  assert.ok(gameChoices(null, '').length >= 10)
})

test('tracked suggestions filter, rank prefix matches first and carry the UUID', () => {
  const players = [
    row('a', 'lizqww'),
    row('b', 'tuff corlay', { status: 'live', last_seen_at: NOW - 5 * 60_000, last_game: 'bed' }),
    row('c', 'corlayfan', { notify: 0 })
  ]
  const choices = trackedChoices(players, 'corlay', NOW)
  assert.deepEqual(
    choices.map((c) => c.value),
    ['c', 'b']
  )
  assert.equal(choices[0]!.name, '⚫ corlayfan · alerts off')
  assert.equal(choices[1]!.name, '🟢 tuff corlay · BedWars 5 min ago')
  assert.equal(trackedChoices(players, '', NOW).length, 3)
})

test('suggestions never exceed 25 choices or 100 characters', () => {
  const many = Array.from({ length: 40 }, (_, i) => row(String(i), 'x'.repeat(120) + i))
  const choices = trackedChoices(many, '', NOW)
  assert.equal(choices.length, 25)
  for (const c of choices) assert.ok(c.name.length <= 100)
})

test('Hive suggestions fall back to the typed name so Enter still works', () => {
  assert.deepEqual(searchChoices(null, ''), [])
  assert.deepEqual(searchChoices(null, 'tuf'), [{ name: 'tuf', value: 'tuf' }])
  assert.deepEqual(searchChoices([], 'zzzzzz'), [{ name: 'zzzzzz (no match on Hive)', value: 'zzzzzz' }])
  assert.deepEqual(
    searchChoices(
      [
        { uuid: '1', username: 'tuff corlay', username_cc: 'tuff corlay', tracked: true },
        { uuid: '2', username: 'tuffy', username_cc: 'Tuffy', tracked: false }
      ],
      'tuff'
    ),
    [
      { name: 'tuff corlay (already tracked)', value: 'tuff corlay' },
      { name: 'Tuffy', value: 'tuffy' }
    ]
  )
})
