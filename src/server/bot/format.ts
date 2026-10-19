import { game } from '../../shared/games.ts'

/** Plain-text relative time for Discord messages. */
export function ago(ts: number, now = Date.now()): string {
  const d = Math.max(0, now - ts)
  const min = Math.round(d / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const hours = Math.round(d / 3_600_000)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(d / 86_400_000)
  return days === 1 ? 'yesterday' : `${days} d ago`
}

export function gameName(id: string): string {
  return game(id).name
}
