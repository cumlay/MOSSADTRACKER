import { useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api.ts'
import { ago, clock, date, dateTime, duration, num, plural, signed, stripColors } from '../lib/format.ts'
import { game } from '../../shared/games.ts'
import { GameBadge, GameTile, StatusPill } from '../components/StatusPill.tsx'
import { Heatmap } from '../components/Heatmap.tsx'
import { HistoryChart } from '../components/HistoryChart.tsx'
import { NextFetch } from '../components/NextFetch.tsx'

export default function PlayerPage() {
  const { uuid = '' } = useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ['player', uuid],
    queryFn: () => api.player(uuid),
    refetchInterval: 30_000
  })

  const refresh = useMutation({
    mutationFn: () => api.refresh(uuid),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['player', uuid] })
  })
  const remove = useMutation({
    mutationFn: () => api.removePlayer(uuid),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['players'] })
      navigate('/')
    }
  })
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.setEnabled(uuid, enabled),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['player', uuid] })
  })
  const toggleNotify = useMutation({
    mutationFn: (notify: boolean) => api.setNotify(uuid, notify),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['player', uuid] })
  })

  if (isLoading) return <p className="text-sm text-[var(--txt-3)]">Loading…</p>
  if (!data) return <p className="text-sm text-[var(--txt-3)]">This player is not tracked.</p>

  const { player: p, games, sessions, events, heatmap, profile } = data
  const played = games.filter((g) => g.latest.played > 0)
  const title = typeof profile?.equipped_hub_title === 'string' ? stripColors(profile.equipped_hub_title) : null

  return (
    <div className="space-y-5">
      <div
        className="glass card-pad flex flex-wrap items-center gap-x-6 gap-y-4 p-6"
        style={{ ['--c' as string]: p.last_game ? game(p.last_game).color : 'var(--a1)' }}
      >
        <GameTile short={p.last_game ? game(p.last_game).short : '—'} color={p.last_game ? game(p.last_game).color : '#6b7386'} />
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-[clamp(22px,3vw,30px)] font-black tracking-[-0.045em]">{p.username_cc ?? p.username}</h1>
            <StatusPill status={p.status} />
            {p.rank && (
              <span className="mono rounded-md px-1.5 py-0.5 text-[10px] font-bold" style={{ color: 'var(--a1)', background: 'color-mix(in oklab, var(--a1), transparent 86%)' }}>
                {p.rank}
              </span>
            )}
          </div>
          <div className="mt-1 text-xs text-[var(--txt-3)]">
            {title && <span className="mr-2 text-[var(--txt-2)]">{title}</span>}
            {p.player_number !== null && <span>player #{num(p.player_number)} · </span>}
            {p.first_played && <span>joined {date(p.first_played * 1000)}</span>}
          </div>
        </div>

        <div className="flex gap-6 text-sm">
          <Field label="last activity">
            {p.last_seen_at ? (
              <>
                {ago(p.last_seen_at)}
                {p.last_seen_window_ms ? <span className="text-[var(--txt-3)]"> ± {duration(p.last_seen_window_ms / 2)}</span> : null}
              </>
            ) : (
              <span className="text-[var(--txt-3)]">never detected</span>
            )}
          </Field>
          <Field label="last mode">
            {p.last_game ? <GameBadge id={p.last_game} color={game(p.last_game).color} label={game(p.last_game).name} /> : '—'}
          </Field>
          <Field label="matches 24 h">{p.matches_24h}</Field>
          <NextFetch dueAt={p.next_fetch_at} lastAt={p.last_fetch_at} bucket={p.next_fetch_bucket} size={40} wide />
        </div>

        <div className="ml-auto flex gap-2">
          <button className="btn btn--ghost" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
            {refresh.isPending ? '…' : 'Refresh'}
          </button>
          <button className="btn btn--ghost" onClick={() => toggleNotify.mutate(p.notify === 0)}>
            {p.notify ? 'Alerts on' : 'Alerts off'}
          </button>
          <button className="btn btn--ghost" onClick={() => toggle.mutate(p.enabled === 0)}>
            {p.enabled ? 'Pause' : 'Resume'}
          </button>
          <button className="btn btn--ghost" style={{ color: 'var(--bad)' }} onClick={() => remove.mutate()}>
            Remove
          </button>
        </div>
      </div>

      {refresh.isError && (
        <p className="text-xs text-[var(--warn)]">
          Bucket quota spent — the next request for this player/game pair opens later (3 per hour).
        </p>
      )}

      <div className="grid gap-5 lg:grid-cols-[1fr_380px]">
        <div className="space-y-5">
          <HistoryChart uuid={uuid} />

          <section className="glass card-pad p-5">
            <div className="label mb-3">Play habits (last 60 days)</div>
            <Heatmap grid={heatmap} />
          </section>

          <section className="glass card-pad p-5">
            <div className="label mb-3">Stats per mode</div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wider text-[var(--txt-3)]">
                    <th className="pb-2 font-medium">Mode</th>
                    <th className="pb-2 text-right font-medium">Played</th>
                    <th className="pb-2 text-right font-medium">Wins</th>
                    <th className="pb-2 text-right font-medium">K/D</th>
                    <th className="pb-2 text-right font-medium">24 h</th>
                    <th className="pb-2 text-right font-medium">7 d</th>
                  </tr>
                </thead>
                <tbody>
                  {played.map((g) => {
                    const info = game(g.game)
                    // Several modes have no kill counter at all (BlockParty, Build Battle…):
                    // showing "0.00" there would read as a real ratio.
                    const kd =
                      info.stats.includes('kills') && g.latest.deaths > 0
                        ? (g.latest.kills / g.latest.deaths).toFixed(2)
                        : '—'
                    return (
                      <tr key={g.game} className="border-t border-[var(--line-2)]">
                        <td className="py-2">
                          <GameBadge id={g.game} color={info.color} label={info.name} />
                        </td>
                        <td className="py-2 text-right mono">{num(g.latest.played)}</td>
                        <td className="py-2 text-right mono text-[var(--txt-2)]">{num(g.latest.victories)}</td>
                        <td className="py-2 text-right mono text-[var(--txt-2)]">{kd}</td>
                        <td className="py-2 text-right mono text-[var(--ok)]">
                          {g.delta_24h?.played ? signed(g.delta_24h.played) : <span className="text-[var(--txt-3)]">—</span>}
                        </td>
                        <td className="py-2 text-right mono text-[var(--txt-2)]">
                          {g.delta_7d?.played ? signed(g.delta_7d.played) : <span className="text-[var(--txt-3)]">—</span>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <div className="space-y-5">
          <section className="glass card-pad p-5">
            <div className="label mb-3">Sessions</div>
            {sessions.length === 0 && <p className="text-xs text-[var(--txt-3)]">No session recorded yet.</p>}
            <div className="space-y-2">
              {sessions.slice(0, 12).map((s) => (
                <div key={s.id} className="flex items-baseline justify-between gap-3 text-xs">
                  <span className="text-[var(--txt-2)]">{dateTime(s.started_at)}</span>
                  <span className="text-[var(--txt-3)]">
                    {clock(s.started_at)}–{clock(s.ended_at)} · {duration(Math.max(60_000, s.ended_at - s.started_at))}
                  </span>
                  <span className="mono text-[var(--txt-2)]">{plural(s.matches, 'match', 'matches')}</span>
                  <span className="flex gap-1">
                    {s.games.map((id) => (
                      <GameBadge key={id} id={id} color={game(id).color} label={game(id).short} />
                    ))}
                  </span>
                </div>
              ))}
            </div>
          </section>

          <section className="glass card-pad p-5">
            <div className="label mb-3">Raw detections</div>
            <div className="max-h-80 space-y-1.5 overflow-y-auto text-[11px]">
              {events.map((e) => (
                <div key={e.id} className="flex items-baseline gap-2">
                  <span className="mono text-[var(--txt-3)]">
                    {clock(e.window_start)}–{clock(e.window_end)}
                  </span>
                  {e.game === 'unknown' ? (
                    <span className="text-[var(--txt-3)]">activity (mode unknown)</span>
                  ) : (
                    <GameBadge id={e.game} color={game(e.game).color} label={game(e.game).short} />
                  )}
                  <span className="text-[var(--txt-2)]">{e.matches > 0 ? plural(e.matches, 'match', 'matches') : 'quest'}</span>
                  {e.delta.kills ? <span className="text-[var(--txt-3)]">{signed(e.delta.kills)} kills</span> : null}
                </div>
              ))}
              {events.length === 0 && <p className="text-[var(--txt-3)]">Nothing detected yet.</p>}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="label">{label}</div>
      <div className="mt-0.5 text-sm">{children}</div>
    </div>
  )
}
