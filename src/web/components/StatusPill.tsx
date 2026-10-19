import { STATUS_META } from '../lib/format.ts'
import type { Status } from '../../shared/types.ts'

export function StatusPill({ status, pulse = false }: { status: Status; pulse?: boolean }) {
  const meta = STATUS_META[status]
  return (
    <span className="pill" style={{ color: meta.color }}>
      <span className={`dot ${status === 'live' || pulse ? 'is-live' : ''}`} style={{ background: meta.color }} />
      {meta.label}
    </span>
  )
}

/** A game's colour carried as a tinted pill — the NinjaStats chip, sized down. */
export function GameBadge({ id, color, label }: { id: string; color: string; label: string }) {
  return (
    <span
      key={id}
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-[3px] text-[11.5px] font-semibold"
      style={{
        color,
        background: `color-mix(in oklab, ${color}, transparent 88%)`,
        border: `1px solid color-mix(in oklab, ${color}, transparent 70%)`
      }}
    >
      {label}
    </span>
  )
}

/** Square badge with the game's short code, as on the NinjaStats mode cards. */
export function GameTile({ short, color }: { short: string; color: string }) {
  return (
    <span className="tile" style={{ ['--c' as string]: color }}>
      {short}
    </span>
  )
}
