import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api.ts'
import { useMe } from '../lib/useAccess.ts'

export function AddPlayer() {
  const qc = useQueryClient()
  const [term, setTerm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const me = useMe()

  const query = term.trim()
  const { data: results, isFetching } = useQuery({
    queryKey: ['search', query],
    queryFn: () => api.search(query),
    enabled: query.length >= 4,
    staleTime: 60_000
  })

  const add = useMutation({
    mutationFn: (identifier: string) => api.addPlayer(identifier),
    onSuccess: () => {
      setTerm('')
      setError(null)
      void qc.invalidateQueries({ queryKey: ['players'] })
      void qc.invalidateQueries({ queryKey: ['me'] })
    },
    onError: (err: Error & { status?: number; limit?: number }) => {
      setError(
        err.message === 'limit'
          ? `You already have ${err.limit} players on the watchlist, your limit. Ask a Tracker admin to raise it.`
          : err.status === 404
          ? 'No such player on The Hive.'
          : err.message === 'already_tracked'
            ? 'Already on the watchlist.'
            : err.message === 'rate_limited'
              ? 'Quota spent for this player, try again in an hour.'
              : 'Could not add that player.'
      )
    }
  })

  return (
    <div className="glass card-pad p-5">
      <div className="mb-3 flex items-baseline justify-between">
        <div className="label">Track a player</div>
        {me?.limit !== null && me?.limit !== undefined && (
          <span className="mono text-[11px] text-[var(--txt-3)]" title="Players you added that are still tracked">
            {me.added}/{me.limit} used
          </span>
        )}
      </div>

      <div className="flex gap-2">
        <input
          value={term}
          onChange={(e) => {
            setTerm(e.target.value)
            setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && term.trim().length >= 3) add.mutate(term.trim())
          }}
          placeholder="Hive username"
          className="glass-well min-w-0 flex-1 px-4 py-2 text-sm outline-none transition-colors placeholder:text-[var(--txt-3)] focus:border-[color-mix(in_oklab,var(--a1),transparent_55%)]"
        />
        <button className="btn" disabled={term.trim().length < 3 || add.isPending} onClick={() => add.mutate(term.trim())}>
          {add.isPending ? '…' : 'Track'}
        </button>
      </div>

      {error && <p className="mt-2 text-[11.5px]" style={{ color: 'var(--bad)' }}>{error}</p>}

      {query.length >= 4 && (
        <div className="mt-3 max-h-64 space-y-1 overflow-y-auto">
          {isFetching && <p className="text-[11.5px] text-[var(--txt-3)]">Searching…</p>}
          {results?.length === 0 && !isFetching && <p className="text-[11.5px] text-[var(--txt-3)]">No player found.</p>}
          {results?.map((r) => (
            <button
              key={r.uuid}
              disabled={r.tracked || add.isPending}
              onClick={() => add.mutate(r.username_cc ?? r.username)}
              className="flex w-full items-center justify-between rounded-[12px] px-3 py-1.5 text-left text-sm transition-colors hover:bg-white/[0.06] disabled:opacity-35"
            >
              <span className="font-semibold">{r.username_cc ?? r.username}</span>
              <span className="text-[11px] text-[var(--txt-3)]">{r.tracked ? 'tracked' : 'add'}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
