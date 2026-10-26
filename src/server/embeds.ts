import { game } from '../shared/games.ts'
import type { Report, SessionSummary } from './insights.ts'

/**
 * Discord embeds for everything the bot posts on its own. Plain objects, so they work
 * both through discord.js and through a webhook, and can be tested without Discord.
 */

export interface Embed {
  title: string
  description?: string
  color: number
  fields?: Array<{ name: string; value: string; inline?: boolean }>
  footer?: { text: string }
  timestamp?: string
}

export const BRAND = 'Mossad Tracker'
export const ACCENT = 0xf5c518
const GREY = 0x6b7386

/** Discord renders <t:…> in each reader's own timezone. */
export const t = (ts: number, style: 't' | 'f' | 'R' | 'd' | 'D' = 't') => `<t:${Math.floor(ts / 1000)}:${style}>`

export function dur(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000))
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m ? `${h} h ${m}` : `${h} h`
}

const colorOf = (gameId: string | undefined) => (gameId ? parseInt(game(gameId).color.slice(1), 16) : ACCENT)
const plural = (n: number, one: string, many = one + 'es') => `${n} ${n === 1 ? one : many}`

export function sessionStartEmbed(
  name: string,
  alert: { gameId: string; matches: number; windowStart: number; windowEnd: number },
  extra: { with: string[]; backAfterMs: number | null }
): Embed {
  const info = game(alert.gameId)
  const fields = [
    { name: 'Game', value: info.name, inline: true },
    { name: 'Matches', value: String(alert.matches), inline: true },
    // Never imply more precision than the polling interval gives us.
    { name: 'Seen', value: `between ${t(alert.windowStart)} and ${t(alert.windowEnd)}`, inline: true }
  ]
  if (extra.with.length > 0) fields.push({ name: 'Probably with', value: extra.with.join(', '), inline: false })
  return {
    title: `🟢 ${name} is online`,
    description:
      `Started playing **${info.name}**.` + (extra.backAfterMs !== null ? `\nBack after **${dur(extra.backAfterMs)}** away.` : ''),
    color: colorOf(alert.gameId),
    fields,
    footer: { text: `${BRAND} · inferred from Hive stat changes` },
    timestamp: new Date(alert.windowEnd).toISOString()
  }
}

export function sessionEndEmbed(s: SessionSummary): Embed {
  const lines = s.games.map((g) => {
    const parts = [plural(g.matches, 'match'), plural(g.wins, 'win', 'wins')]
    if (g.kills > 0) parts.push(plural(g.kills, 'kill', 'kills'))
    if (g.levels) parts.push(`level ${g.levels.from} → **${g.levels.to}**`)
    return `**${game(g.game).name}** — ${parts.join(' · ')}`
  })
  const fields = [
    { name: 'Played', value: `${t(s.started_at)} – ${t(s.ended_at)}`, inline: true },
    { name: 'Duration', value: dur(s.ended_at - s.started_at), inline: true },
    { name: 'Matches', value: String(s.matches), inline: true }
  ]
  if (s.with.length > 0) fields.push({ name: 'Probably with', value: s.with.join(', '), inline: false })
  return {
    title: `⚫ ${s.name} stopped playing`,
    description: lines.join('\n') || 'No finished match was detected.',
    color: colorOf(s.games[0]?.game),
    fields,
    footer: { text: `${BRAND} · session summary` },
    timestamp: new Date(s.ended_at).toISOString()
  }
}

export function milestoneEmbed(name: string, gameId: string, text: string, emoji: string): Embed {
  return {
    title: `${emoji} ${name} — ${game(gameId).name}`,
    description: text,
    color: colorOf(gameId),
    footer: { text: `${BRAND} · milestone` },
    timestamp: new Date().toISOString()
  }
}

export function inactiveEmbed(name: string, lastSeenAt: number | null, lastGame: string | null, days: number): Embed {
  return {
    title: `💤 ${name} has gone quiet`,
    description: lastSeenAt
      ? `No match for **${days}+ days** — last seen ${t(lastSeenAt, 'R')}${lastGame ? ` on ${game(lastGame).name}` : ''}.`
      : `Not seen playing since they were added ${days}+ days ago.`,
    color: GREY,
    footer: { text: `${BRAND} · now checked every 2 hours until they play again` }
  }
}

export function reportEmbed(r: Report, title: string): Embed {
  if (r.active === 0) {
    return { title, description: 'Nobody on the watchlist played in this period.', color: GREY, footer: { text: BRAND } }
  }
  const fields = [
    { name: 'Matches', value: String(r.matches), inline: true },
    { name: 'Active players', value: String(r.active), inline: true },
    { name: 'Most played', value: r.top_game ? `${game(r.top_game.game).name} (${r.top_game.matches})` : '—', inline: true },
    {
      name: 'Most active',
      value: r.top.map((p, i) => `${['🥇', '🥈', '🥉', '4.', '5.'][i]} **${p.name}** — ${plural(p.matches, 'match')}`).join('\n'),
      inline: false
    }
  ]
  if (r.longest) {
    fields.push({
      name: 'Longest session',
      value: `**${r.longest.name}** — ${dur(r.longest.ms)}, ${plural(r.longest.matches, 'match')}${
        r.longest.games.length ? ` (${r.longest.games.map((g) => game(g).name).join(', ')})` : ''
      }`,
      inline: false
    })
  }
  if (r.level_ups.length > 0) {
    fields.push({
      name: 'Biggest level-ups',
      value: r.level_ups.map((l) => `**${l.name}** ${game(l.game).name} ${l.from} → **${l.to}**`).join('\n'),
      inline: false
    })
  }
  return { title, description: `${t(r.from, 'f')} → ${t(r.to, 'f')}`, color: ACCENT, fields, footer: { text: BRAND } }
}

/**
 * A tracked player standing in the same lobby as the in-game client.
 *
 * Unlike every other alert, this one carries no uncertainty wording: the client read
 * the server's own player list, so the moment and the server are exact.
 */
export function sightingEmbed(
  name: string,
  gameId: string | null,
  server: string | null,
  mode: string | null,
  at: number
): Embed {
  const where = gameId ? game(gameId).name + (mode ? ` ${mode}` : '') : (mode ?? 'a Hive lobby')
  return {
    title: `${name} is in your lobby`,
    description: `**${where}**${server ? ` · \`${server}\`` : ''} — seen ${t(at, 'R')}`,
    color: colorOf(gameId ?? undefined),
    footer: { text: `${BRAND} · in-game` },
    timestamp: new Date(at).toISOString()
  }
}
