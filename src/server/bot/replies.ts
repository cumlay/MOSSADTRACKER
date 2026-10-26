import { all, get } from '../db.ts'
import { listPlayers } from '../queries.ts'
import { statCard } from '../stats.ts'
import { buildReport, playedWith, timeline, typicalHours } from '../insights.ts'
import { ACCENT, BRAND, dur, reportEmbed, t, type Embed } from '../embeds.ts'
import { typicalText } from '../../shared/insights.ts'
import { game } from '../../shared/games.ts'
import type { Period, PlayerRow } from '../../shared/types.ts'
import { statusDot } from './commands.ts'

/** Embeds for the read-only commands. Plain data in, plain embed out. */

const n = (v: number) => v.toLocaleString('en-GB')
const pct = (v: number) => `${(v * 100).toFixed(1)}%`
const ratio = (a: number, b: number) => (b > 0 ? a / b : a)
const nameOf = (p: PlayerRow) => p.username_cc ?? p.username
const colorOf = (gameId: string) => parseInt(game(gameId).color.slice(1), 16)

const PERIOD_LABEL: Record<Period | 'all', string> = { all: 'all time', day: 'today', week: 'this week', month: 'this month' }

/* ------------------------------------------------------------------ /stats */

export async function statsEmbed(p: PlayerRow, gameId: string, period: Period | 'all'): Promise<Embed | string> {
  const card = await statCard(p.uuid, gameId, period)
  if (!card) return `No ${game(gameId).name} stats for **${nameOf(p)}** yet.`

  const s = card.stats
  const fields: NonNullable<Embed['fields']> = [
    { name: 'Played', value: n(s.played ?? 0), inline: true },
    { name: 'Wins', value: n(s.victories ?? 0), inline: true },
    { name: 'Win rate', value: pct(card.derived.win_rate), inline: true }
  ]
  if (card.derived.kdr !== null) {
    fields.push(
      { name: 'Kills', value: n(s.kills ?? 0), inline: true },
      { name: 'Deaths', value: n(s.deaths ?? 0), inline: true },
      { name: 'K/D', value: card.derived.kdr.toFixed(2), inline: true }
    )
  }
  if (s.final_kills !== undefined) fields.push({ name: 'Final kills', value: n(s.final_kills), inline: true })
  if (card.level) {
    const prestige = card.level.prestige > 0 ? ` · prestige ${card.level.prestige}` : ''
    fields.push({ name: 'Level', value: `${card.level.level} / ${card.level.max_level}${prestige}`, inline: true })
  }
  if (period === 'all') {
    const streak = get<{ win_streak: number; best_streak: number }>('SELECT win_streak, best_streak FROM game_state WHERE uuid = ? AND game = ?', [
      p.uuid,
      gameId
    ])
    if (streak && streak.best_streak > 0) {
      fields.push({ name: 'Win streak', value: `${streak.win_streak} now · best ${streak.best_streak} seen`, inline: true })
    }
  }
  if (card.monthly_rank) fields.push({ name: 'Monthly rank', value: `#${card.monthly_rank}`, inline: true })

  const source =
    card.source === 'lifetime' ? 'lifetime counters' : card.source === 'hive_month' ? "Hive's monthly figures" : 'changes seen by the tracker'
  return {
    title: `${nameOf(p)} — ${game(gameId).name}`,
    description: `Stats ${PERIOD_LABEL[period]}${p.rank ? ` · rank **${p.rank}**` : ''}`,
    color: colorOf(gameId),
    fields,
    footer: { text: `${BRAND} · ${source}` }
  }
}

/* --------------------------------------------------------------- /sessions */

export function sessionsEmbed(p: PlayerRow, now = Date.now()): Embed {
  const sessions = timeline(p.uuid, 60, now).reverse().slice(0, 10)
  const lines = sessions.map((s) => {
    const games = Object.entries(s.per_game)
      .sort((a, b) => b[1] - a[1])
      .map(([g, m]) => `${game(g).short} ${m}`)
      .join(', ')
    return `${t(s.started_at, 'f')} · ${dur(s.ended_at - s.started_at)} · **${s.matches}** ${s.matches === 1 ? 'match' : 'matches'}${games ? ` (${games})` : ''}`
  })

  const fields: NonNullable<Embed['fields']> = []
  const typical = typicalHours(p.uuid, now)
  fields.push({
    name: 'Usually online',
    value: typical ? `${typicalText(typical)} · ${typical.timezone}` : 'Not enough play recorded yet.',
    inline: false
  })
  const mates = playedWith(p.uuid, 60, now)
  if (mates.length > 0) {
    fields.push({
      name: 'Often plays with',
      value: mates.map((m) => `**${m.username}** — ${m.sessions} ${m.sessions === 1 ? 'session' : 'sessions'}, last ${t(m.last_at, 'R')}`).join('\n'),
      inline: false
    })
  }

  return {
    title: `${statusDot(p.status)} ${nameOf(p)} — recent sessions`,
    description: lines.join('\n') || 'No session recorded in the last 60 days.',
    color: ACCENT,
    fields,
    footer: { text: `${BRAND} · times shown in your timezone` }
  }
}

/* ----------------------------------------------------------------- /online */

export function onlineEmbed(now = Date.now()): Embed {
  const playing = listPlayers(now).filter((p) => p.session !== null || p.status === 'live')
  if (playing.length === 0) {
    return { title: 'Nobody is playing right now', description: 'No tracked player finished a match in the last 30 minutes.', color: 0x6b7386 }
  }
  const lines = playing.map((p) => {
    const games = (p.session?.games ?? (p.last_game ? [p.last_game] : [])).map((g) => game(g).name).join(', ') || 'game not identified yet'
    const since = p.session ? ` · since ${t(p.session.started_at)} · ${p.session.matches} ${p.session.matches === 1 ? 'match' : 'matches'}` : ''
    return `${statusDot(p.status)} **${nameOf(p)}** — ${games}${since}`
  })
  return {
    title: `🟢 ${playing.length} playing now`,
    description: lines.join('\n').slice(0, 4000),
    color: 0x34d399,
    footer: { text: `${BRAND} · a player shows up once a match ends` }
  }
}

/* ---------------------------------------------------------------- /compare */

interface GameRow {
  game: string
  played: number
  victories: number
  kills: number
  deaths: number
}

const rowsOf = (uuid: string) =>
  all<GameRow>("SELECT game, played, victories, kills, deaths FROM game_state WHERE uuid = ? AND game NOT IN ('main', 'unknown')", [uuid])

/** "▲" on the better side of a comparison. */
const mark = (mine: number, theirs: number) => (mine > theirs ? ' ▲' : '')

export async function compareEmbed(a: PlayerRow, b: PlayerRow, gameId: string | null): Promise<Embed | string> {
  if (gameId) {
    const [ca, cb] = await Promise.all([statCard(a.uuid, gameId, 'all'), statCard(b.uuid, gameId, 'all')])
    if (!ca || !cb) return `Both players need ${game(gameId).name} stats to compare.`
    const side = (c: typeof ca, o: typeof cb) =>
      [
        `Played **${n(c.stats.played ?? 0)}**${mark(c.stats.played ?? 0, o.stats.played ?? 0)}`,
        `Wins **${n(c.stats.victories ?? 0)}**${mark(c.stats.victories ?? 0, o.stats.victories ?? 0)}`,
        `Win rate **${pct(c.derived.win_rate)}**${mark(c.derived.win_rate, o.derived.win_rate)}`,
        c.derived.kdr !== null ? `K/D **${c.derived.kdr.toFixed(2)}**${mark(c.derived.kdr, o.derived.kdr ?? 0)}` : null,
        c.stats.final_kills !== undefined ? `Final kills **${n(c.stats.final_kills)}**${mark(c.stats.final_kills, o.stats.final_kills ?? 0)}` : null,
        c.level ? `Level **${c.level.level}**${c.level.prestige ? ` (P${c.level.prestige})` : ''}${mark(c.level.prestige * 1000 + c.level.level, (o.level?.prestige ?? 0) * 1000 + (o.level?.level ?? 0))}` : null
      ]
        .filter(Boolean)
        .join('\n')
    return {
      title: `${nameOf(a)} vs ${nameOf(b)} — ${game(gameId).name}`,
      color: colorOf(gameId),
      fields: [
        { name: nameOf(a), value: side(ca, cb), inline: true },
        { name: nameOf(b), value: side(cb, ca), inline: true }
      ],
      footer: { text: `${BRAND} · lifetime · ▲ = ahead` }
    }
  }

  const ra = new Map(rowsOf(a.uuid).map((r) => [r.game, r]))
  const rb = new Map(rowsOf(b.uuid).map((r) => [r.game, r]))
  const shared = [...ra.keys()]
    .filter((g) => (ra.get(g)!.played > 0 || (rb.get(g)?.played ?? 0) > 0) && rb.has(g))
    .sort((x, y) => rb.get(y)!.played + ra.get(y)!.played - (rb.get(x)!.played + ra.get(x)!.played))
    .slice(0, 8)
  if (shared.length === 0) return `**${nameOf(a)}** and **${nameOf(b)}** have no game in common yet.`

  const line = (name: string, r: GameRow, o: GameRow) => {
    const wr = ratio(r.victories, r.played)
    const kd = ratio(r.kills, r.deaths)
    const hasKills = game(r.game).stats.includes('kills')
    return `${name}: ${n(r.played)} played · ${pct(wr)}${mark(wr, ratio(o.victories, o.played))}${
      hasKills ? ` · ${kd.toFixed(2)} K/D${mark(kd, ratio(o.kills, o.deaths))}` : ''
    }`
  }
  return {
    title: `${nameOf(a)} vs ${nameOf(b)}`,
    color: ACCENT,
    fields: shared.map((g) => ({
      name: game(g).name,
      value: `${line(nameOf(a), ra.get(g)!, rb.get(g)!)}\n${line(nameOf(b), rb.get(g)!, ra.get(g)!)}`,
      inline: false
    })),
    footer: { text: `${BRAND} · lifetime · win rate and K/D, ▲ = ahead · /compare game: for one game in detail` }
  }
}

/* ----------------------------------------------------------------- /report */

const startOfDay = (ts: number) => {
  const d = new Date(ts)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

export async function reportReply(period: 'today' | 'yesterday' | 'week', now = Date.now()): Promise<Embed> {
  const today = startOfDay(now)
  if (period === 'yesterday') {
    const from = startOfDay(today - 12 * 3_600_000)
    return reportEmbed(await buildReport(from, today), '📊 Report — yesterday')
  }
  if (period === 'week') return reportEmbed(await buildReport(now - 7 * 86_400_000, now), '🗓️ Report — last 7 days')
  return reportEmbed(await buildReport(today, now), '📊 Report — today so far')
}
