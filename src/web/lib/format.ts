import type { Status } from '../../shared/types.ts'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** Locale used across the UI: 24-hour clock, day-first dates. */
const LOCALE = 'en-GB'

/** "8 min ago" — short, and never claims more precision than we have. */
export function ago(ts: number | null, now = Date.now()): string {
  if (ts === null) return 'never'
  const d = Math.max(0, now - ts)
  if (d < MIN) return 'just now'
  if (d < HOUR) return `${Math.round(d / MIN)} min ago`
  if (d < DAY) return `${Math.round(d / HOUR)} h ago`
  const days = Math.round(d / DAY)
  return days === 1 ? 'yesterday' : `${days} d ago`
}

export function duration(ms: number): string {
  if (ms < MIN) return `${Math.round(ms / 1000)} s`
  if (ms < HOUR) return `${Math.round(ms / MIN)} min`
  const h = Math.floor(ms / HOUR)
  const m = Math.round((ms % HOUR) / MIN)
  return m ? `${h} h ${m}` : `${h} h`
}

export function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })
}

export function dateTime(ts: number): string {
  return new Date(ts).toLocaleString(LOCALE, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

export function date(ts: number): string {
  return new Date(ts).toLocaleDateString(LOCALE, { day: '2-digit', month: 'short', year: 'numeric' })
}

/** Status colours come straight from the shared palette, not from Tailwind classes. */
export const STATUS_META: Record<Status, { label: string; color: string }> = {
  live: { label: 'playing', color: '#34d399' },
  recent: { label: 'just played', color: '#22d3ee' },
  today: { label: 'today', color: '#fbbf24' },
  idle: { label: 'idle', color: '#a2aabd' },
  stale: { label: 'away', color: '#6b7386' },
  unknown: { label: 'no data yet', color: '#6b7386' }
}

/** Minecraft &-colour codes -> plain text (we keep the text, drop the codes). */
export function stripColors(s: string): string {
  return s.replace(/&[0-9a-fk-or]/gi, '').trim()
}

/** "1 match" / "3 matches" */
export function plural(n: number, one: string, many = one + 's'): string {
  return `${n} ${n > 1 ? many : one}`
}

export function num(n: number): string {
  return n.toLocaleString(LOCALE)
}

export function signed(n: number): string {
  return (n > 0 ? '+' : '') + num(n)
}
