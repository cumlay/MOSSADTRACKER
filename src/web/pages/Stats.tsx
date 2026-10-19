import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api.ts'
import { game } from '../../shared/games.ts'
import { StatCard } from '../components/StatCard.tsx'
import type { Period } from '../../shared/types.ts'

const PERIODS: Array<{ id: Period | 'all'; label: string }> = [
  { id: 'all', label: 'All time' },
  { id: 'month', label: 'This month' },
  { id: 'week', label: 'This week' },
  { id: 'day', label: 'Today' }
]

export default function Stats() {
  const [params, setParams] = useSearchParams()
  const [period, setPeriod] = useState<Period | 'all'>('all')

  const { data: players } = useQuery({ queryKey: ['players'], queryFn: api.players })
  const uuid = params.get('player') ?? players?.[0]?.uuid ?? ''

  const { data: detail } = useQuery({
    queryKey: ['player', uuid],
    queryFn: () => api.player(uuid),
    enabled: Boolean(uuid)
  })

  // Games this player has actually touched, busiest first.
  const played = (detail?.games ?? []).filter((g) => g.latest.played > 0)
  const gameId = params.get('game') ?? played[0]?.game ?? ''

  useEffect(() => {
    // Switching player can leave a game selected that they never played.
    if (gameId && played.length > 0 && !played.some((g) => g.game === gameId)) {
      setParams({ player: uuid, game: played[0]!.game }, { replace: true })
    }
  }, [gameId, played, uuid, setParams])

  const { data: card, isLoading } = useQuery({
    queryKey: ['stats', uuid, gameId, period],
    queryFn: () => api.stats(uuid, gameId, period),
    enabled: Boolean(uuid && gameId)
  })

  const select = (next: { player?: string; game?: string }) => {
    setParams({ player: next.player ?? uuid, game: next.game ?? gameId })
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <div>
          <h1 className="text-[clamp(26px,4vw,38px)] font-black tracking-[-0.05em]">
            Stat<span className="grad-text">istics</span>
          </h1>
          <p className="mt-1 text-[12.5px] text-[var(--txt-3)]">
            Every mode a tracked player has touched, lifetime or scoped to a period.
          </p>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <select
            value={uuid}
            onChange={(e) => select({ player: e.target.value, game: '' })}
            className="glass-well px-4 py-2 text-sm outline-none"
          >
            {players?.map((p) => (
              <option key={p.uuid} value={p.uuid} style={{ background: 'var(--bg-2)' }}>
                {p.username_cc ?? p.username}
              </option>
            ))}
          </select>

          <div className="glass-well flex gap-0.5 p-1">
            {PERIODS.map((p) => (
              <button
                key={p.id}
                onClick={() => setPeriod(p.id)}
                className="rounded-full px-3 py-1 text-[11.5px] font-semibold transition-all duration-300"
                style={
                  period === p.id ? { color: '#08090d', background: 'var(--grad)' } : { color: 'var(--txt-3)' }
                }
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      {played.length > 0 && (
        <div className="flex flex-wrap gap-[7px]">
          {played.map((g) => {
            const info = game(g.game)
            const on = g.game === gameId
            return (
              <button
                key={g.game}
                onClick={() => select({ game: g.game })}
                className={`gchip ${on ? 'is-on' : ''}`}
                style={{ ['--c' as string]: info.color }}
              >
                <i />
                {info.name}
              </button>
            )
          })}
        </div>
      )}

      {isLoading && <p className="text-sm text-[var(--txt-3)]">Loading…</p>}
      {card && <StatCard card={card} />}
      {!isLoading && !card && uuid && (
        <div className="glass p-8 text-center text-sm text-[var(--txt-2)]">No stats recorded for this mode yet.</div>
      )}
      {players?.length === 0 && (
        <div className="glass p-8 text-center text-sm text-[var(--txt-2)]">
          Track a player from the Snipe tab first — statistics are built from the players on your watchlist.
        </div>
      )}
    </div>
  )
}
