import type { Typical } from './types.ts'

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

const hh = (h: number) => `${String(h % 24).padStart(2, '0')}:00`

/** "19:00–23:00 (64% of their play), mostly Fri, Sat" */
export function typicalText(t: Typical): string {
  const days = t.days.length > 0 ? `, mostly ${t.days.map((d) => WEEKDAYS[d]).join(', ')}` : ''
  return `${hh(t.from)}–${hh(t.to)} (${Math.round(t.share * 100)}% of their play)${days}`
}
