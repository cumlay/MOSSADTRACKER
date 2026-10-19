import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api.ts'
import { ago, clock, duration, num, plural, STATUS_META } from '../lib/format.ts'
import { game } from '../../shared/games.ts'
import { GameTile, StatusPill } from '../components/StatusPill.tsx'
import { AddPlayer } from '../components/AddPlayer.tsx'
import { AlertSettings } from '../components/AlertSettings.tsx'
import { HealthPanel } from '../components/HealthPanel.tsx'
import { NextFetch } from '../components/NextFetch.tsx'
import { GameFilter, matchesFilter } from '../components/GameFilter.tsx'
import { useStream } from '../lib/useStream.ts'
import type { PlayerRow } from '../../shared/types.ts'

type Range = '24h' | '7d' | '30d'

const RANGES: Array<{ id: Range; label: string; pick: (p: PlayerRow) => number }> = [
  { id: '24h', label: '24 h', pick: (p) => p.matches_24h },
  { id: '7d', label: '7 d', pick: (p) => p.matches_7d },
  { id: '30d', label: '30 d', pick: (p) => p.matches_30d }
]

type Sort = 'recent' | 'matches' | 'name'

const SORTS: Array<{ id: Sort; label: string }> = [
  { id: 'recent', label: 'Last seen' },
  { id: 'matches', label: 'Most active' },
  { id: 'name', label: 'Name' }
]

export default function Dashboard() {
  const { pulses } = useStream()
  const { data: players, isLoading } = useQuery({ queryKey: ['players'], queryFn: api.players, refetchInterval: 30_000 })

  const [range, setRange] = useState<Range>('24h')
  const [sort, setSort] = useState<Sort>('recent')
  const [search, setSearch] = useState('')

  // Survives reloads: the filter you left on is the filter you come back to.
  const [selected, setSelected] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('ninjatracker.gameFilter') ?? '[]') as string[]
    } catch {
      return []
    }
  })
  const applyFilter = (next: string[]) => {
    setSelected(next)
    localStorage.setItem('ninjatracker.gameFilter', JSON.stringify(next))
  }

  const needle = search.trim().toLowerCase()
  const shown = (players ?? [])
    .filter((p) => matchesFilter(p, selected))
    .filter((p) => !needle || (p.username_cc ?? p.username).toLowerCase().includes(needle))
    .sort((a, b) => {
      if (sort === 'name') return (a.username_cc ?? a.username).localeCompare(b.username_cc ?? b.username)
      if (sort === 'matches') return RANGES.find((r) => r.id === range)!.pick(b) - RANGES.find((r) => r.id === range)!.pick(a)
      return (b.last_seen_at ?? 0) - (a.last_seen_at ?? 0)
    })

  const live = shown.filter((p) => p.status === 'live').length
  const today = shown.filter((p) => p.status === 'recent' || p.status === 'today').length
  const matches = shown.reduce((sum, p) => sum + RANGES.find((r) => r.id === range)!.pick(p), 0)

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_330px]">
      <div className="space-y-4">
        <header className="flex flex-wrap items-end gap-x-6 gap-y-3">
          <div>
            <h1 className="text-[clamp(26px,4vw,38px)] font-black tracking-[-0.05em]">
              Watch<span className="grad-text">list</span>
            </h1>
            <p className="mt-1 text-[12.5px] text-[var(--txt-3)]">
              Who is on right now, what they are playing, and when the next check lands.
            </p>
          </div>

          <div className="ml-auto flex gap-[clamp(14px,3vw,34px)]">
            <Stat value={live} label="playing" tone="var(--ok)" />
            <Stat value={today} label="active today" />
            <Stat value={num(matches)} label={`matches ${range}`} />
          </div>
        </header>

        <div className="flex flex-wrap items-center gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by name…"
            className="glass-well min-w-[180px] flex-1 px-4 py-2 text-sm outline-none transition-colors placeholder:text-[var(--txt-3)] focus:border-[color-mix(in_oklab,var(--a1),transparent_55%)]"
          />

          <Segmented items={SORTS} value={sort} onChange={setSort} />
          <Segmented
            items={RANGES.map((r) => ({ id: r.id, label: r.label }))}
            value={range}
            onChange={setRange}
            title="Matches counted over this window"
          />
        </div>

        {players && players.length > 0 && (
          <GameFilter players={players} selected={selected} onChange={applyFilter} />
        )}

        {isLoading && <p className="text-sm text-[var(--txt-3)]">Loading…</p>}

        {players?.length === 0 && (
          <div className="glass card-pad p-8 text-center text-sm text-[var(--txt-2)]">
            No players tracked yet. Add a username on the right to start recording their activity.
          </div>
        )}

        {shown.length === 0 && players && players.length > 0 && (
          <div className="glass p-6 text-center text-sm text-[var(--txt-2)]">
            {needle ? `No tracked player matches "${search.trim()}".` : 'No tracked player has been seen on these modes yet.'}
          </div>
        )}

        <div className="space-y-2.5">
          {shown.map((p) => (
            <PlayerLine key={p.uuid} player={p} pulsedAt={pulses[p.uuid]} range={range} />
          ))}
        </div>
      </div>

      <aside className="space-y-4">
        <AddPlayer />
        <AlertSettings />
        <HealthPanel />
        <Legend />
      </aside>
    </div>
  )
}

function Stat({ value, label, tone }: { value: number | string; label: string; tone?: string }) {
  return (
    <div className="grid gap-0.5 text-center">
      <b className="mono text-[21px] font-extrabold tracking-[-0.04em]" style={tone ? { color: tone } : undefined}>
        {value}
      </b>
      <span className="label">{label}</span>
    </div>
  )
}

function Segmented<T extends string>({
  items,
  value,
  onChange,
  title
}: {
  items: Array<{ id: T; label: string }>
  value: T
  onChange: (next: T) => void
  title?: string
}) {
  return (
    <div className="glass-well flex gap-0.5 p-1" title={title}>
      {items.map((item) => (
        <button
          key={item.id}
          onClick={() => onChange(item.id)}
          className="rounded-full px-3 py-1 text-[11.5px] font-semibold transition-all duration-300"
          style={
            value === item.id
              ? { color: '#08090d', background: 'var(--grad)' }
              : { color: 'var(--txt-3)' }
          }
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

function PlayerLine({ player: p, pulsedAt, range }: { player: PlayerRow; pulsedAt?: number; range: Range }) {
  const count = RANGES.find((r) => r.id === range)!.pick(p)
  const g = p.last_game ? game(p.last_game) : null
  const recentPulse = pulsedAt !== undefined && Date.now() - pulsedAt < 60_000
  const meta = STATUS_META[p.status]
  const color = g?.color ?? '#6b7386'

  return (
    <Link
      to={`/player/${p.uuid}`}
      className="mode flex items-center gap-3 px-4 py-3.5 sm:gap-4 sm:px-5"
      style={{
        ['--c' as string]: color,
        ...(recentPulse ? { borderColor: 'color-mix(in oklab, var(--ok), transparent 55%)' } : {})
      }}
      onMouseMove={(e) => {
        // Feeds the radial highlight in .mode::before.
        const r = e.currentTarget.getBoundingClientRect()
        e.currentTarget.style.setProperty('--mx', `${e.clientX - r.left}px`)
        e.currentTarget.style.setProperty('--my', `${e.clientY - r.top}px`)
      }}
    >
      <GameTile short={g?.short ?? '—'} color={color} />

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-[15px] font-bold tracking-[-0.02em]">{p.username_cc ?? p.username}</span>
          <StatusPill status={p.status} pulse={recentPulse} />
          {p.enabled === 0 && <span className="text-[11px] text-[var(--txt-3)]">(paused)</span>}
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-[var(--txt-3)]">
          {g ? <span style={{ color }}>{g.name}</span> : <span>no match detected yet</span>}
          {p.last_seen_at && (
            <span style={{ color: meta.color }}>
              {ago(p.last_seen_at)}
              {p.last_seen_window_ms ? (
                <span className="text-[var(--txt-3)]"> (± {duration(p.last_seen_window_ms / 2)})</span>
              ) : null}
            </span>
          )}
        </div>
      </div>

      {p.session && (
        <div className="hidden text-right lg:block">
          <div className="label">session</div>
          <div className="text-[12.5px] text-[var(--txt-2)]">
            since {clock(p.session.started_at)} · {plural(p.session.matches, 'match', 'matches')}
          </div>
        </div>
      )}

      <div className="hidden w-14 text-right sm:block">
        <div className="label">{RANGES.find((r) => r.id === range)?.label}</div>
        <div
          className="mono text-[15px] font-extrabold tracking-[-0.04em]"
          style={{ color: count > 0 ? 'var(--txt)' : 'var(--txt-3)' }}
        >
          {count}
        </div>
      </div>

      <NextFetch dueAt={p.next_fetch_at} lastAt={p.last_fetch_at} bucket={p.next_fetch_bucket} />
    </Link>
  )
}

function Legend() {
  return (
    <div className="glass card-pad p-5 text-[11.5px] leading-relaxed text-[var(--txt-2)]">
      <div className="label mb-2">How this is measured</div>
      <p>
        The Hive API exposes no "online" status. Activity is inferred from match counters moving between
        two checks, so a player becomes visible only once a match ends.
      </p>
      <ul className="mt-3 space-y-1">
        <li>
          <b style={{ color: STATUS_META.live.color }}>playing</b> — a match ended less than 15 min ago
        </li>
        <li>
          <b style={{ color: STATUS_META.recent.color }}>just played</b> — within the hour
        </li>
        <li>
          <b style={{ color: STATUS_META.today.color }}>today</b> — within 24 h
        </li>
      </ul>
      <p className="mt-3 text-[var(--txt-3)]">
        The ring counts down to the next check. Active players are checked more often, roughly every
        7 minutes; quiet ones every 20.
      </p>
    </div>
  )
}
