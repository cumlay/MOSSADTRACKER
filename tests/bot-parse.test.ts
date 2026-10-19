import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCommand, playerArg } from '../src/server/bot/parse.ts'

test('parses a named argument in double quotes', () => {
  const parsed = parseCommand('.addTracker player:"tuff corlay"')!
  assert.equal(parsed.command, 'addtracker')
  assert.equal(playerArg(parsed), 'tuff corlay')
})

test('the command name is case-insensitive', () => {
  assert.equal(parseCommand('.ADDTRACKER player:"x"')!.command, 'addtracker')
  assert.equal(parseCommand('.trackerList')!.command, 'trackerlist')
})

test('accepts an unquoted value and single quotes', () => {
  assert.equal(playerArg(parseCommand(".addTracker player:Lizqfx")!), 'Lizqfx')
  assert.equal(playerArg(parseCommand(".addTracker player:'two is chill'")!), 'two is chill')
})

test('a bare value works too, spaces included', () => {
  // Bedrock gamertags contain spaces, so the tail must not be split on whitespace.
  assert.equal(playerArg(parseCommand('.addTracker tuff corlay')!), 'tuff corlay')
  assert.equal(playerArg(parseCommand('.addTracker "two is chill"')!), 'two is chill')
})

test('tolerates spacing around the colon and extra whitespace', () => {
  assert.equal(playerArg(parseCommand('  .addTracker   player :  "tuff corlay"  ')!), 'tuff corlay')
})

test('a command with no argument yields an empty target', () => {
  assert.equal(playerArg(parseCommand('.trackerList')!), '')
})

test('ignores anything that is not a command', () => {
  assert.equal(parseCommand('hello there'), null)
  assert.equal(parseCommand('...'), null)
  assert.equal(parseCommand(''), null)
})

test('honours a custom prefix', () => {
  assert.equal(parseCommand('!trackerList', '!')!.command, 'trackerlist')
  assert.equal(parseCommand('.trackerList', '!'), null)
})
