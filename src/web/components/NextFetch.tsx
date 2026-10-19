import { useEffect, useState } from 'react'

/** Re-renders every second so countdowns actually tick. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

/** "4 min" / "45 s" / "now" — the plain answer to "when do I get fresh data?". */
export function untilText(dueAt: number, now: number): string {
  const ms = dueAt - now
  if (ms <= 5_000) return 'now'
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`
  return `${Math.round(ms / 60_000)} min`
}

interface Props {
  dueAt: number | null
  lastAt: number | null
  bucket?: string | null
  size?: number
  /** Big variant for the player page. */
  wide?: boolean
}

/**
 * Countdown to the next API fetch, with a ring that drains as the wait elapses.
 * The whole point is that "when will this update?" needs zero explanation.
 */
export function NextFetch({ dueAt, lastAt, bucket, size = 34, wide = false }: Props) {
  const now = useNow()

  if (dueAt === null) {
    return <span className="text-[11px] text-[var(--txt-3)]">paused</span>
  }

  const span = lastAt && dueAt > lastAt ? dueAt - lastAt : 20 * 60_000
  const elapsed = Math.min(span, Math.max(0, now - (dueAt - span)))
  const progress = span > 0 ? elapsed / span : 1
  const imminent = dueAt - now <= 30_000

  const r = (size - 4) / 2
  const c = 2 * Math.PI * r

  const ring = (
    <svg width={size} height={size} className={imminent ? 'animate-pulse' : ''}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.09)" strokeWidth="2.5" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={imminent ? 'var(--ok)' : 'var(--a2)'}
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - progress)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dashoffset 0.8s linear' }}
      />
    </svg>
  )

  if (wide) {
    return (
      <div className="flex items-center gap-3">
        {ring}
        <div>
          <div className="label">next update</div>
          <div className="mono text-sm font-bold">
            {untilText(dueAt, now)}
            {bucket && <span className="ml-1.5 text-[11px] font-normal text-[var(--txt-3)]">via {bucket}</span>}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2.5" title={bucket ? `next request uses the "${bucket}" bucket` : undefined}>
      {ring}
      <div className="text-right">
        <div className="label">next</div>
        <div className="mono text-[13px] font-bold" style={{ color: imminent ? 'var(--ok)' : 'var(--txt-2)' }}>
          {untilText(dueAt, now)}
        </div>
      </div>
    </div>
  )
}
