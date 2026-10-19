import { canonicalGame, game } from '../../shared/games.ts'
import type { PlayerRow } from '../../shared/types.ts'

/**
 * A player matches a game if that is what they last played, or what their live session
 * contains. Sub-modes roll up: someone last seen in SkyWars Kits matches SkyWars.
 */
export function playerGames(p: PlayerRow): string[] {
  const out = new Set<string>()
  if (p.last_game) out.add(canonicalGame(p.last_game))
  for (const g of p.session?.games ?? []) out.add(canonicalGame(g))
  return [...out]
}

export function matchesFilter(p: PlayerRow, selected: string[]): boolean {
  if (selected.length === 0) return true
  const mine = playerGames(p)
  return selected.some((g) => mine.includes(g))
}

interface Props {
  players: PlayerRow[]
  selected: string[]
  onChange: (next: string[]) => void
}

/** Multi-select game chips. Picking sky + bed shows the union of both. */
export function GameFilter({ players, selected, onChange }: Props) {
  const counts = new Map<string, number>()
  for (const p of players) {
    for (const g of playerGames(p)) counts.set(g, (counts.get(g) ?? 0) + 1)
  }
  const available = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))

  if (available.length === 0) return null

  const toggle = (id: string) => {
    onChange(selected.includes(id) ? selected.filter((g) => g !== id) : [...selected, id])
  }

  return (
    <div className="flex flex-wrap items-center gap-[7px]">
      <button
        onClick={() => onChange([])}
        className="gchip"
        style={selected.length === 0 ? { color: 'var(--txt)', background: 'rgba(255,255,255,.07)' } : undefined}
      >
        All
        <span className="mono text-[11px] opacity-60">{players.length}</span>
      </button>

      {available.map(([id, count]) => {
        const info = game(id)
        const on = selected.includes(id)
        return (
          <button
            key={id}
            onClick={() => toggle(id)}
            aria-pressed={on}
            className={`gchip ${on ? 'is-on' : ''}`}
            style={{ ['--c' as string]: info.color }}
          >
            <i />
            {info.name}
            <span className="mono text-[11px] opacity-60">{count}</span>
          </button>
        )
      })}

      {selected.length > 0 && (
        <button onClick={() => onChange([])} className="ml-auto text-[11.5px] text-[var(--txt-3)] transition-colors hover:text-[var(--txt)]">
          clear
        </button>
      )}
    </div>
  )
}
