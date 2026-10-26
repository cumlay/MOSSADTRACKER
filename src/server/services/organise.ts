import { all, get, j, lastInsertId, run } from '../db.ts'
import { broadcast } from '../events.ts'
import { getPlayer } from '../queries.ts'
import { audit, type Actor } from '../audit.ts'
import type { Group, Note, PlayerRow } from '../../shared/types.ts'

/**
 * Staff annotations on the watchlist: tags, groups and notes. Like the watchlist
 * services, every change is audited and pushed to open pages.
 */

export class InputError extends Error {}

const TAG = /^[\p{L}\p{N} _.?!#&'+-]{1,24}$/u
const MAX_TAGS = 12
const NOTE_MAX = 1000
const COLOR = /^#[0-9a-f]{6}$/i
const CHANNEL = /^\d{17,20}$/

function targetOf(uuid: string) {
  const p = get<{ name: string }>('SELECT COALESCE(username_cc, username) AS name FROM players WHERE uuid = ?', [uuid])
  return p ? { uuid, name: p.name } : null
}

function changed(uuid: string): PlayerRow | null {
  const player = getPlayer(uuid)
  broadcast('player', { uuid, player })
  return player
}

/* -------------------------------------------------------------------- tags */

export function setTags(uuid: string, input: unknown, actor: Actor): PlayerRow | null {
  const target = targetOf(uuid)
  if (!target) return null
  if (!Array.isArray(input)) throw new InputError('tags must be a list')

  const tags = [...new Set(input.map((t) => String(t).trim()).filter(Boolean))]
  if (tags.length > MAX_TAGS) throw new InputError(`at most ${MAX_TAGS} tags`)
  const bad = tags.find((t) => !TAG.test(t))
  if (bad) throw new InputError(`invalid tag "${bad.slice(0, 30)}"`)

  run('UPDATE players SET tags = ? WHERE uuid = ?', [j(tags), uuid])
  audit(actor, 'tags', target, tags.join(', ') || '(none)')
  return changed(uuid)
}

/* ------------------------------------------------------------------ groups */

export function listGroups(): Group[] {
  return all<Group>('SELECT id, name, color, channel_id FROM player_groups ORDER BY name')
}

function cleanGroup(input: { name?: unknown; color?: unknown; channel_id?: unknown }, partial: boolean) {
  const out: Partial<Omit<Group, 'id'>> = {}
  if (input.name !== undefined || !partial) {
    const name = String(input.name ?? '').trim()
    if (!name || name.length > 32) throw new InputError('group name must be 1–32 characters')
    out.name = name
  }
  if (input.color !== undefined || !partial) {
    const color = String(input.color ?? '#7c5cff')
    if (!COLOR.test(color)) throw new InputError('colour must look like #7c5cff')
    out.color = color
  }
  if (input.channel_id !== undefined) {
    const channel = input.channel_id === null ? '' : String(input.channel_id).trim()
    if (channel && !CHANNEL.test(channel)) throw new InputError('channel ID must be the 17–20 digit Discord ID')
    out.channel_id = channel || null
  }
  return out
}

export function createGroup(input: Record<string, unknown>, actor: Actor): Group {
  const g = cleanGroup(input, false)
  if (get('SELECT id FROM player_groups WHERE name = ?', [g.name])) throw new InputError('a group with that name exists')
  run('INSERT INTO player_groups (name, color, channel_id) VALUES (?, ?, ?)', [g.name!, g.color!, g.channel_id ?? null])
  const group = get<Group>('SELECT id, name, color, channel_id FROM player_groups WHERE id = ?', [lastInsertId()])!
  audit(actor, 'group create', null, group.name)
  broadcast('groups', {})
  return group
}

export function updateGroup(id: number, input: Record<string, unknown>, actor: Actor): Group | null {
  const before = get<Group>('SELECT id, name, color, channel_id FROM player_groups WHERE id = ?', [id])
  if (!before) return null
  const g = cleanGroup(input, true)
  if (g.name && get('SELECT id FROM player_groups WHERE name = ? AND id != ?', [g.name, id])) {
    throw new InputError('a group with that name exists')
  }
  const next = { ...before, ...g }
  run('UPDATE player_groups SET name = ?, color = ?, channel_id = ? WHERE id = ?', [next.name, next.color, next.channel_id, id])
  audit(actor, 'group edit', null, next.name === before.name ? next.name : `${before.name} → ${next.name}`)
  broadcast('groups', {})
  return next
}

export function deleteGroup(id: number, actor: Actor): boolean {
  const g = get<{ name: string }>('SELECT name FROM player_groups WHERE id = ?', [id])
  if (!g) return false
  run('UPDATE players SET group_id = NULL WHERE group_id = ?', [id])
  run('DELETE FROM player_groups WHERE id = ?', [id])
  audit(actor, 'group delete', null, g.name)
  broadcast('groups', {})
  return true
}

export function setGroup(uuid: string, groupId: number | null, actor: Actor): PlayerRow | null {
  const target = targetOf(uuid)
  if (!target) return null
  const group = groupId === null ? null : get<{ name: string }>('SELECT name FROM player_groups WHERE id = ?', [groupId])
  if (groupId !== null && !group) throw new InputError('no such group')
  run('UPDATE players SET group_id = ? WHERE uuid = ?', [groupId, uuid])
  audit(actor, 'group', target, group?.name ?? '(none)')
  return changed(uuid)
}

/* ------------------------------------------------------------------- notes */

export function notesFor(uuid: string): Note[] {
  return all<Note>('SELECT id, author, body, created_at FROM player_notes WHERE uuid = ? ORDER BY created_at DESC', [uuid])
}

export function addNote(uuid: string, body: unknown, actor: Actor): Note | null {
  const target = targetOf(uuid)
  if (!target) return null
  const text = String(body ?? '').trim()
  if (!text || text.length > NOTE_MAX) throw new InputError(`a note is 1–${NOTE_MAX} characters`)
  run('INSERT INTO player_notes (uuid, author, body, created_at) VALUES (?, ?, ?, ?)', [uuid, actor.name, text, Date.now()])
  const note = get<Note>('SELECT id, author, body, created_at FROM player_notes WHERE id = ?', [lastInsertId()])!
  audit(actor, 'note', target, text.length > 120 ? text.slice(0, 119) + '…' : text)
  broadcast('player', { uuid, player: getPlayer(uuid) })
  return note
}

export function deleteNote(uuid: string, id: number, actor: Actor): boolean {
  const note = get<{ body: string }>('SELECT body FROM player_notes WHERE id = ? AND uuid = ?', [id, uuid])
  if (!note) return false
  run('DELETE FROM player_notes WHERE id = ?', [id])
  audit(actor, 'note delete', targetOf(uuid), note.body.length > 120 ? note.body.slice(0, 119) + '…' : note.body)
  broadcast('player', { uuid, player: getPlayer(uuid) })
  return true
}
