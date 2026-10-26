import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { api } from '../lib/api.ts'
import { date, num, plural, signed } from '../lib/format.ts'
import { game } from '../../shared/games.ts'
import { GameBadge } from './StatusPill.tsx'
import { useFullAccess } from '../lib/useAccess.ts'
import type { HistoryBucket, Period } from '../../shared/types.ts'

const PERIODS: Array<{ id: Period; label: string }> = [
  { id: 'day', label: 'Daily' },
  { id: 'week', label: 'Weekly' },
  { id: 'month', label: 'Monthly' }
]

export function HistoryChart({ uuid }: { uuid: string }) {
  const qc = useQueryClient()
  const full = useFullAccess()
  const [period, setPeriod] = useState<Period>('day')
  const rebuild = useMutation({
    mutationFn: () => api.backfill(6),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['history', uuid] })
  })
  const { data, isLoading } = useQuery({
    queryKey: ['history', uuid, period],
    queryFn: () => api.history(uuid, period),
    refetchInterval: 60_000
  })

  const buckets = data?.buckets ?? []
  const games = [...new Set(buckets.flatMap((b) => Object.keys(b.per_game)))]
  const current = buckets[buckets.length - 1]
  const untracked = buckets.filter((b) => !b.tracked).length
  const fromHive = buckets.filter((b) => b.source === 'hive').length

  const rows = buckets.map((b) => ({
    label: b.label,
    tracked: b.tracked,
    ...Object.fromEntries(games.map((g) => [g, b.per_game[g] ?? 0]))
  }))

  return (
    <section className="glass p-5">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="label">Activity over time</div>

        <div className="glass-well ml-auto flex gap-0.5 p-1">
          {PERIODS.map((p) => (
            <button
              key={p.id}
              onClick={() => setPeriod(p.id)}
              className="rounded-full px-3 py-1 text-[11.5px] font-semibold transition-all duration-300"
              style={period === p.id ? { color: '#08090d', background: 'var(--grad)' } : { color: 'var(--txt-3)' }}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {isLoading && <p className="text-xs text-[var(--txt-3)]">Loading…</p>}

      {current && <CurrentTotals bucket={current} period={period} />}

      <div className="mt-4 h-52">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 4, right: 4, bottom: 0, left: -22 }}>
            <XAxis
              dataKey="label"
              tick={{ fill: '#6b7386', fontSize: 10 }}
              axisLine={{ stroke: 'rgba(255,255,255,0.09)' }}
              tickLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              tick={{ fill: '#6b7386', fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              allowDecimals={false}
            />
            <Tooltip
              cursor={{ fill: 'rgba(255,255,255,0.05)' }}
              contentStyle={{
                background: 'rgba(10,12,19,0.94)',
                border: '1px solid rgba(255,255,255,0.09)',
                borderRadius: 18,
                fontSize: 12,
                backdropFilter: 'blur(12px)'
              }}
              labelStyle={{ color: '#a2aabd' }}
              formatter={(value: number, name: string) => [value, game(name).name]}
            />
            {games.map((g, i) => (
              <Bar
                key={g}
                dataKey={g}
                stackId="matches"
                fill={game(g).color}
                radius={i === games.length - 1 ? [4, 4, 0, 0] : undefined}
                maxBarSize={38}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>

      {fromHive > 0 && (
        <p className="mt-3 text-[11px] leading-relaxed text-[var(--txt-3)]">
          {fromHive} month{fromHive > 1 ? 's' : ''} rebuilt from Hive's monthly leaderboards — those cover the
          full month, including before this player joined the watchlist. A month with no bar may simply mean
          they were outside the top 100 that month.
        </p>
      )}

      {untracked > 0 && data && (
        <p className="mt-3 text-[11px] leading-relaxed text-[var(--txt-3)]">
          Tracking started {date(data.tracking_since)}. The {untracked} earlier{' '}
          {period === 'day' ? 'days' : period === 'week' ? 'weeks' : 'months'} are empty because nobody was
          watching then — not because they did not play.
          {period === 'month' && full && (
            <button
              onClick={() => rebuild.mutate()}
              disabled={rebuild.isPending}
              className="ml-1.5 underline decoration-dotted underline-offset-2 transition-colors hover:text-[var(--txt-2)] disabled:opacity-40"
            >
              {rebuild.isPending ? 'rebuilding…' : 'rebuild from leaderboards'}
            </button>
          )}
        </p>
      )}

      {period === 'month' && <OfficialMonth data={data} />}
    </section>
  )
}

function CurrentTotals({ bucket, period }: { bucket: HistoryBucket; period: Period }) {
  const label = period === 'day' ? 'Today' : period === 'week' ? 'This week' : 'This month'
  const t = bucket.totals

  return (
    <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
      <div>
        <div className="label">{label}</div>
        <div className="mono text-[26px] font-extrabold tracking-[-0.045em]">{bucket.matches}</div>
        <div className="text-[11px] text-[var(--txt-3)]">{plural(bucket.matches, 'match', 'matches')} observed</div>
      </div>
      {(['victories', 'kills', 'deaths', 'xp'] as const).map((k) =>
        t[k] ? (
          <div key={k}>
            <div className="label">{k}</div>
            <div className="mono text-sm font-bold">{signed(t[k]!)}</div>
          </div>
        ) : null
      )}
      <div className="flex flex-wrap gap-1">
        {Object.entries(bucket.per_game)
          .sort((a, b) => b[1] - a[1])
          .map(([g, n]) => (
            <GameBadge key={g} id={g} color={game(g).color} label={`${game(g).short} ${n}`} />
          ))}
      </div>
    </div>
  )
}

/**
 * Hive's own month-to-date totals. Unlike the chart above, these cover the whole month
 * including the part that happened before this player was added to the watchlist.
 */
function OfficialMonth({ data }: { data: { official_month: { per_game: Record<string, Record<string, number>> } | null } | undefined }) {
  const official = data?.official_month
  if (!official || Object.keys(official.per_game).length === 0) {
    return (
      <p className="mt-3 text-[11px] text-[var(--txt-3)]">
        Hive's own month totals will appear here once a per-game request budget frees up.
      </p>
    )
  }

  return (
    <div className="mt-4 border-t border-[var(--line-2)] pt-3">
      <div className="label mb-2">Month to date, straight from Hive</div>
      <div className="space-y-1.5">
        {Object.entries(official.per_game).map(([g, stats]) => (
          <div key={g} className="flex flex-wrap items-baseline gap-x-3 text-xs">
            <GameBadge id={g} color={game(g).color} label={game(g).name} />
            <span className="mono text-[var(--txt-2)]">{num(stats.played ?? 0)} played</span>
            {stats.victories !== undefined && (
              <span className="mono text-[var(--txt-3)]">{num(stats.victories)} wins</span>
            )}
            {stats.kills !== undefined && <span className="mono text-[var(--txt-3)]">{num(stats.kills)} kills</span>}
            {stats.human_index !== undefined && (
              <span className="text-[var(--txt-3)]">rank #{num(stats.human_index)}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
