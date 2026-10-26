import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api.ts'
import { clock, duration, plural } from '../lib/format.ts'
import { game } from '../../shared/games.ts'
import type { TimelineSession } from '../../shared/types.ts'

const SPANS = [14, 28, 56, 90]
const DAY = 24 * 60 * 60 * 1000

interface Segment {
  session: TimelineSession
  /** Fractions of the day, 0–1. */
  left: number
  width: number
  color: string
}

function dayStart(ts: number): number {
  const d = new Date(ts)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** Main game of a session, by matches: what its bar is coloured with. */
function mainGame(s: TimelineSession): string | null {
  const top = Object.entries(s.per_game).sort((a, b) => b[1] - a[1])[0]
  return top?.[0] ?? s.games[0] ?? null
}

/** Sessions cut at midnight, so a late-night session shows on both days. */
function byDay(sessions: TimelineSession[], days: number, now: number): Array<{ start: number; segments: Segment[] }> {
  const today = dayStart(now)
  const rows = Array.from({ length: days }, (_, i) => ({ start: dayStart(today - i * DAY + DAY / 2), segments: [] as Segment[] }))
  const index = new Map(rows.map((r, i) => [r.start, i]))

  for (const s of sessions) {
    const id = mainGame(s)
    const color = id ? game(id).color : '#6b7386'
    // A single detection has no width; show it as a few minutes so it stays visible.
    const end = Math.max(s.ended_at, s.started_at + 4 * 60_000)
    let cursor = s.started_at
    while (cursor < end) {
      const start = dayStart(cursor)
      const next = dayStart(start + DAY + DAY / 2)
      const sliceEnd = Math.min(end, next)
      const row = index.get(start)
      if (row !== undefined) {
        rows[row]!.segments.push({ session: s, left: (cursor - start) / DAY, width: (sliceEnd - cursor) / DAY, color })
      }
      cursor = sliceEnd
    }
  }
  return rows
}

/** Calendar of every session: one row per day, 24 h across, coloured by main game. */
export function Timeline({ uuid }: { uuid: string }) {
  const [days, setDays] = useState(28)
  const { data } = useQuery({ queryKey: ['timeline', uuid, days], queryFn: () => api.timeline(uuid, days), refetchInterval: 60_000 })

  const now = Date.now()
  const rows = byDay(data?.sessions ?? [], days, now)
  const games = [...new Set((data?.sessions ?? []).map(mainGame).filter((g): g is string => g !== null))]

  return (
    <section className="glass card-pad p-5">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="label">Activity timeline</div>
        <div className="ml-auto flex gap-1">
          {SPANS.map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className="rounded-full px-2.5 py-0.5 text-[11px] font-semibold transition-colors"
              style={days === d ? { color: '#08090d', background: 'var(--grad)' } : { color: 'var(--txt-3)' }}
            >
              {d} d
            </button>
          ))}
        </div>
      </div>

      <div className="mb-1 ml-[74px] flex justify-between text-[10px] text-[var(--txt-3)]">
        {[0, 6, 12, 18, 24].map((h) => (
          <span key={h} className="mono">
            {String(h).padStart(2, '0')}
          </span>
        ))}
      </div>

      <div className="max-h-[420px] space-y-[3px] overflow-y-auto pr-1">
        {rows.map((row) => (
          <div key={row.start} className="flex items-center gap-2">
            <span className="mono w-[66px] shrink-0 text-right text-[10.5px] text-[var(--txt-3)]">
              {new Date(row.start).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' })}
            </span>
            <div className="glass-well relative h-[14px] flex-1 overflow-hidden" style={{ borderRadius: 5 }}>
              {[6, 12, 18].map((h) => (
                <i key={h} className="absolute inset-y-0 w-px bg-white/[0.05]" style={{ left: `${(h / 24) * 100}%` }} />
              ))}
              {row.segments.map((seg, i) => (
                <span
                  key={i}
                  className="absolute inset-y-[2px] rounded-[3px]"
                  style={{ left: `${seg.left * 100}%`, width: `max(3px, ${seg.width * 100}%)`, background: seg.color }}
                  title={`${clock(seg.session.started_at)}–${clock(seg.session.ended_at)} · ${duration(
                    Math.max(60_000, seg.session.ended_at - seg.session.started_at)
                  )} · ${plural(seg.session.matches, 'match', 'matches')}\n${Object.entries(seg.session.per_game)
                    .map(([g, n]) => `${game(g).name}: ${n}`)
                    .join('\n')}`}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {games.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-3 text-[11px] text-[var(--txt-3)]">
          {games.map((g) => (
            <span key={g} className="inline-flex items-center gap-1.5">
              <i className="inline-block h-2 w-2 rounded-full" style={{ background: game(g).color }} />
              {game(g).name}
            </span>
          ))}
        </div>
      )}
    </section>
  )
}
