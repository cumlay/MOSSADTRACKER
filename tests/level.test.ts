import { test } from 'node:test'
import assert from 'node:assert/strict'
import { levelFor } from '../src/server/hive/meta.ts'
import type { GameMeta } from '../src/server/hive/meta.ts'

/**
 * Mirrors the real shape of `/v0/game/meta/{game}`: XP threshold -> table index, where
 * index 0 sits at 0 XP and Hive displays that as level 1.
 */
const meta: GameMeta = {
  name: 'TestWars',
  shortName: 'TW',
  maxLevel: 5,
  allowPrestiging: true,
  maxPrestige: 2,
  experienceToLevel: { '0': 0, '100': 1, '300': 2, '600': 3, '1000': 4 }
}

test('zero XP is level 1, not level 0', () => {
  assert.equal(levelFor(meta, 0).level, 1)
})

test('a threshold reached exactly counts as that level', () => {
  assert.equal(levelFor(meta, 100).level, 2)
  assert.equal(levelFor(meta, 600).level, 4)
})

test('progress is measured inside the current level', () => {
  const info = levelFor(meta, 450) // between 300 (index 2) and 600
  assert.equal(info.level, 3)
  assert.equal(info.xp_into_level, 150)
  assert.equal(info.xp_for_level, 300)
  assert.equal(info.is_max, false)
})

test('the cap is reported as max level with a full bar', () => {
  const info = levelFor(meta, 1000)
  assert.equal(info.level, 5)
  assert.equal(info.is_max, true)
  assert.equal(info.xp_into_level, info.xp_for_level, 'a maxed player shows a full bar')
})

test('XP beyond the last listed threshold never exceeds the cap', () => {
  const info = levelFor(meta, 999_999)
  assert.equal(info.level, meta.maxLevel)
  assert.equal(info.is_max, true)
})

test('prestige is carried through, and reported as zero when the mode has none', () => {
  assert.equal(levelFor(meta, 500, 2).prestige, 2)
  assert.equal(levelFor(meta, 500).max_prestige, 2)
  assert.equal(levelFor({ ...meta, allowPrestiging: false }, 500).max_prestige, 0)
})
