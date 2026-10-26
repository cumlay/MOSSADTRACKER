import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useInfiniteQuery } from '@tanstack/react-query'
import { api } from '../lib/api.ts'
import { dateTime } from '../lib/format.ts'
import { useFullAccess } from '../lib/useAccess.ts'
import type { AuditEntry } from '../../shared/types.ts'

const TONE: Record<string, string> = {
  track: 'var(--ok)',
  untrack: 'var(--bad)',
  'note delete': 'var(--bad)',
  'group delete': 'var(--bad)',
  settings: 'var(--warn)'
}

const SOURCE: Record<AuditEntry['source'], string> = { web: 'website', discord: 'Discord', system: 'system' }

/** Who changed the watchlist, from the website or Discord. Full access only. */
export default function Audit() {
  const full = useFullAccess()
  const [filter, setFilter] = useState('')
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading, error } = useInfiniteQuery({
    queryKey: ['audit'],
    queryFn: ({ pageParam }) => api.audit(pageParam),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => (last.length === 200 ? last[last.length - 1]!.id : undefined),
    enabled: full
  })

  if (!full) return <p className="text-sm text-[var(--txt-3)]">The audit log needs full Tracker access.</p>

  const needle = filter.trim().toLowerCase()
  const entries = (data?.pages.flat() ?? []).filter(
    (e) => !needle || [e.actor, e.action, e.target_name ?? '', e.detail ?? ''].some((v) => v.toLowerCase().includes(needle))
  )

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end gap-4">
        <div>
          <h1 className="text-[clamp(26px,4vw,38px)] font-black tracking-[-0.05em]">
            Audit <span className="grad-text">log</span>
          </h1>
          <p className="mt-1 text-[12.5px] text-[var(--txt-3)]">Every change to the watchlist, from the website and from Discord.</p>
        </div>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by person, action, player…"
          className="glass-well ml-auto min-w-[220px] px-4 py-2 text-sm outline-none placeholder:text-[var(--txt-3)]"
        />
      </header>

      <div className="glass card-pad overflow-x-auto p-5">
        {isLoading && <p className="text-sm text-[var(--txt-3)]">Loading…</p>}
        {error && <p className="text-sm" style={{ color: 'var(--bad)' }}>Could not load the log.</p>}
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wider text-[var(--txt-3)]">
              <th className="pb-2 font-medium">When</th>
              <th className="pb-2 font-medium">Who</th>
              <th className="pb-2 font-medium">Action</th>
              <th className="pb-2 font-medium">Player</th>
              <th className="pb-2 font-medium">Detail</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} className="border-t border-[var(--line-2)] align-top">
                <td className="mono whitespace-nowrap py-2 pr-4 text-[var(--txt-3)]">{dateTime(e.at)}</td>
                <td className="whitespace-nowrap py-2 pr-4">
                  <span className="font-semibold">{e.actor}</span>
                  <span className="ml-1.5 text-[10.5px] text-[var(--txt-3)]">{SOURCE[e.source]}</span>
                </td>
                <td className="whitespace-nowrap py-2 pr-4 font-semibold" style={{ color: TONE[e.action] ?? 'var(--txt-2)' }}>
                  {e.action}
                </td>
                <td className="whitespace-nowrap py-2 pr-4">
                  {e.target_uuid && e.action !== 'untrack' ? (
                    <Link to={`/player/${e.target_uuid}`} className="hover:underline">
                      {e.target_name}
                    </Link>
                  ) : (
                    <span className="text-[var(--txt-2)]">{e.target_name ?? '—'}</span>
                  )}
                </td>
                <td className="py-2 text-[var(--txt-3)]">{e.detail ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!isLoading && entries.length === 0 && <p className="mt-2 text-sm text-[var(--txt-3)]">Nothing recorded yet.</p>}
        {hasNextPage && (
          <button className="btn btn--ghost mt-3" disabled={isFetchingNextPage} onClick={() => void fetchNextPage()}>
            {isFetchingNextPage ? '…' : 'Older entries'}
          </button>
        )}
      </div>
    </div>
  )
}
