import { SlashCommandBuilder, type ApplicationCommandOptionChoiceData, type SlashCommandStringOption } from 'discord.js'
import type { Group, PlayerRow, SearchResult } from '../../shared/types.ts'
import { GAMES } from '../../shared/games.ts'
import { ago, gameName } from './format.ts'

/**
 * Slash command definitions and the pure parts of autocomplete, kept apart from the
 * client so they can be tested without a Discord connection.
 *
 * Each action is its own top-level command: Discord's per-role overrides
 * (Server Settings → Integrations) apply to whole commands, not subcommands, so this
 * is what lets a server open /watchlist to everyone and keep /untrack for staff.
 */

/*
 * No default member permission on any command: who may change the watchlist is decided
 * by the bot itself, from the website account linked with /link (tracker = everything,
 * trackerUser = add only) or, for members who never linked, the Manage Server permission.
 * Servers can still hide commands per role in Server Settings → Integrations.
 */

const playerOption = (name: string, description: string) => (o: SlashCommandStringOption) =>
  o.setName(name).setDescription(description).setRequired(true).setAutocomplete(true)

export const commands = [
  new SlashCommandBuilder()
    .setName('track')
    .setDescription('Start tracking a Hive player')
    .setDMPermission(false)
    .addStringOption((o) =>
      o.setName('player').setDescription('Hive gamertag (type 4+ letters for suggestions)').setRequired(true).setAutocomplete(true)
    ),
  new SlashCommandBuilder()
    .setName('untrack')
    .setDescription('Stop tracking a player and delete their recorded history')
    .setDMPermission(false)
    .addStringOption(playerOption('player', 'Tracked player')),
  new SlashCommandBuilder()
    .setName('alerts')
    .setDescription('Turn online alerts on or off for one tracked player')
    .setDMPermission(false)
    .addStringOption(playerOption('player', 'Tracked player'))
    .addBooleanOption((o) => o.setName('enabled').setDescription('Post an embed when they start playing').setRequired(true)),
  new SlashCommandBuilder()
    .setName('watchlist')
    .setDescription('Show every tracked player and who is playing right now')
    .setDMPermission(false)
    .addStringOption((o) => o.setName('group').setDescription('Only this group').setAutocomplete(true)),
  new SlashCommandBuilder()
    .setName('online')
    .setDescription('Who is playing right now, what, and for how long')
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName('stats')
    .setDescription("A tracked player's stats for one game")
    .setDMPermission(false)
    .addStringOption(playerOption('player', 'Tracked player'))
    .addStringOption((o) => o.setName('game').setDescription('Game').setRequired(true).setAutocomplete(true))
    .addStringOption((o) =>
      o
        .setName('period')
        .setDescription('Lifetime by default')
        .addChoices(
          { name: 'All time', value: 'all' },
          { name: 'Today', value: 'day' },
          { name: 'This week', value: 'week' },
          { name: 'This month', value: 'month' }
        )
    ),
  new SlashCommandBuilder()
    .setName('sessions')
    .setDescription("A tracked player's last play sessions, usual hours and who they play with")
    .setDMPermission(false)
    .addStringOption(playerOption('player', 'Tracked player')),
  new SlashCommandBuilder()
    .setName('compare')
    .setDescription('Two tracked players side by side')
    .setDMPermission(false)
    .addStringOption(playerOption('player1', 'First player'))
    .addStringOption(playerOption('player2', 'Second player'))
    .addStringOption((o) => o.setName('game').setDescription('One game in detail (default: every game both play)').setAutocomplete(true)),
  new SlashCommandBuilder()
    .setName('report')
    .setDescription('Activity report: most active, longest session, level-ups')
    .setDMPermission(false)
    .addStringOption((o) =>
      o
        .setName('period')
        .setDescription('Today by default')
        .addChoices(
          { name: 'Today', value: 'today' },
          { name: 'Yesterday', value: 'yesterday' },
          { name: 'Last 7 days', value: 'week' }
        )
    ),
  new SlashCommandBuilder()
    .setName('link')
    .setDescription('Link your website account (get the code on the Members page)')
    .addStringOption((o) => o.setName('code').setDescription('Code from the website').setRequired(true).setMinLength(4).setMaxLength(16)),
  new SlashCommandBuilder().setName('unlink').setDescription('Unlink your website account from this Discord account')
].map((c) => c.toJSON())

/** Commands that change the watchlist, and the access each needs. */
export const WRITE_COMMANDS: Record<string, 'user' | 'full'> = { track: 'user', untrack: 'full', alerts: 'full' }

/** Discord's limits: 25 choices, names and values 1–100 characters. */
const MAX_CHOICES = 25
const clip = (s: string) => (s.length > 100 ? s.slice(0, 99) + '…' : s)

export function statusDot(status: string): string {
  return status === 'live' ? '🟢' : status === 'recent' ? '🟡' : status === 'today' ? '🟠' : status === 'unknown' ? '⚪' : '⚫'
}

/** Suggestions for /untrack and /alerts: the local watchlist, no Hive call. Value is the UUID. */
export function trackedChoices(players: PlayerRow[], typed: string, now = Date.now()): ApplicationCommandOptionChoiceData<string>[] {
  const needle = typed.trim().toLowerCase()
  return players
    .filter((p) => !needle || p.username.toLowerCase().includes(needle) || (p.username_cc ?? '').toLowerCase().includes(needle))
    .sort((a, b) => Number(!a.username.toLowerCase().startsWith(needle)) - Number(!b.username.toLowerCase().startsWith(needle)))
    .slice(0, MAX_CHOICES)
    .map((p) => {
      const seen = p.last_seen_at ? ` · ${p.last_game ? gameName(p.last_game) + ' ' : ''}${ago(p.last_seen_at, now)}` : ''
      const muted = p.notify === 0 ? ' · alerts off' : ''
      return { name: clip(`${statusDot(p.status)} ${p.username_cc ?? p.username}${seen}${muted}`), value: p.uuid }
    })
}

/**
 * Suggestions for /track, from Hive's player search. The value is the gamertag, so a
 * name typed without picking a suggestion still works the same way.
 */
export function searchChoices(results: SearchResult[] | null, typed: string): ApplicationCommandOptionChoiceData<string>[] {
  const name = typed.trim()
  if (!name) return []
  // Hive only searches from 4 characters; offer what was typed so Enter still works.
  if (name.length < 4 || !results) return [{ name: clip(name), value: clip(name) }]

  const choices = results.slice(0, MAX_CHOICES).map((r) => ({
    name: clip(r.tracked ? `${r.username_cc ?? r.username} (already tracked)` : (r.username_cc ?? r.username)),
    value: clip(r.username)
  }))
  return choices.length > 0 ? choices : [{ name: clip(`${name} (no match on Hive)`), value: clip(name) }]
}

/**
 * Suggestions for a `game` option: the games this player has played, most played first,
 * or every game when no player is picked yet.
 */
export function gameChoices(played: Array<{ game: string; played: number }> | null, typed: string): ApplicationCommandOptionChoiceData<string>[] {
  const needle = typed.trim().toLowerCase()
  const known = new Map(GAMES.map((g) => [g.id, g]))
  const ids = played ? played.filter((g) => known.has(g.game)).map((g) => g.game) : GAMES.map((g) => g.id)
  return ids
    .map((id) => known.get(id)!)
    .filter((g) => !needle || g.name.toLowerCase().includes(needle) || g.id.includes(needle) || g.short.toLowerCase() === needle)
    .slice(0, MAX_CHOICES)
    .map((g) => {
      const n = played?.find((p) => p.game === g.id)?.played
      return { name: clip(n !== undefined ? `${g.name} · ${n} played` : g.name), value: g.id }
    })
}

export function groupChoices(groups: Group[], typed: string): ApplicationCommandOptionChoiceData<string>[] {
  const needle = typed.trim().toLowerCase()
  return groups
    .filter((g) => !needle || g.name.toLowerCase().includes(needle))
    .slice(0, MAX_CHOICES)
    .map((g) => ({ name: clip(g.name), value: String(g.id) }))
}
