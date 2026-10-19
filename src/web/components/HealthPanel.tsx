import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api.ts'
import { ago, date, num } from '../lib/format.ts'

/**
 * Request health. The data was always in `fetch_log`; this makes it visible so a
 * silent failure (429 storm, network outage, Hive downtime) is noticeable instead of
 * showing up as "nobody has played in a while".
 */
export function HealthPanel() {
  const [open, setOpen] = useState(false)
  const { data } = useQuery({ queryKey: ['status'], queryFn: api.status, refetchInterval: 20_000 })
  if (!data) return null

  const recent = data.recent_fetches
  const failures = recent.filter((f) => f.status !== 200)
  const load = data.global_used_last_minute / data.global_limit
  const healthy = failures.length === 0

  return (
    <div className="glass card-pad p-5">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center justify-between">
        <span className="label">Health</span>
        <span className="text-[11px] text-[var(--txt-3)]">{open ? 'hide' : 'show'}</span>
      </button>

      <div className="mt-3 flex items-baseline gap-2">
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: healthy ? 'var(--ok)' : 'var(--warn)' }}
        />
        <span className="text-[13.5px] font-semibold">
          {healthy ? 'All calls succeeding' : `${failures.length} failed of last ${recent.length}`}
        </span>
      </div>

      <div className="mt-3">
        <div className="flex justify-between text-[11px] text-[var(--txt-3)]">
          <span>API budget</span>
          <span className="mono">
            {data.global_used_last_minute} / {data.global_limit} per min
          </span>
        </div>
        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full" style={{ background: 'rgba(255,255,255,.06)' }}>
          <div
            className="h-full rounded-full transition-all"
            style={{
              width: `${Math.min(100, load * 100)}%`,
              background: load > 0.8 ? 'var(--bad)' : 'var(--grad)'
            }}
          />
        </div>
      </div>

      <div className="mt-3 flex items-baseline justify-between border-t border-[var(--line-2)] pt-3">
        <span className="text-[11px] text-[var(--txt-3)]">Calls since setup</span>
        <span className="mono text-[13.5px] font-bold">{num(data.lifetime.requests)}</span>
      </div>
      <div className="flex items-baseline justify-between text-[11px] text-[var(--txt-3)]">
        <span>since {date(data.lifetime.since)}</span>
        <span>{data.lifetime.errors > 0 ? `${num(data.lifetime.errors)} failed` : 'no failure'}</span>
      </div>

      {open && (
        <div className="mt-3 max-h-48 space-y-1 overflow-y-auto border-t border-[var(--line-2)] pt-3 text-[11px]">
          {recent.map((f, i) => (
            <div key={i} className="flex items-baseline justify-between gap-2">
              <span className="mono truncate text-[var(--txt-3)]">{f.bucket.split(':')[1] ?? f.bucket}</span>
              <span style={{ color: f.status === 200 ? 'var(--txt-3)' : 'var(--warn)' }}>{f.status}</span>
              <span className="mono text-[var(--txt-3)]">{f.ms} ms</span>
              <span className="text-[var(--txt-3)]">{ago(f.at)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
