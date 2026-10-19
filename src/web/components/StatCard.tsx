import { date, num } from '../lib/format.ts'
import { game } from '../../shared/games.ts'
import { GameTile } from './StatusPill.tsx'
import type { StatCard as Card } from '../../shared/stats.ts'

/** Human labels for the raw counter keys the API returns. */
const LABELS: Record<string, string> = {
  played: 'Games Played',
  victories: 'Wins',
  kills: 'Kills',
  deaths: 'Deaths',
  final_kills: 'Final Kills',
  beds_destroyed: 'Beds Destroyed',
  treasure_destroyed: 'Treasure Destroyed',
  murders: 'Murders',
  murderer_eliminations: 'Murderer Eliminations',
  coins: 'Coins',
  hider_kills: 'Hider Kills',
  seeker_kills: 'Seeker Kills',
  checkpoints: 'Checkpoints',
  activated: 'Traps Activated',
  crates: 'Crates Opened',
  deathmatches: 'Deathmatches',
  ores_mined: 'Ores Mined',
  spells_used: 'Spells Used',
  mystery_chests_destroyed: 'Mystery Chests',
  flags_captured: 'Flags Captured',
  flags_returned: 'Flags Returned',
  assists: 'Assists',
  blocks_destroyed: 'Blocks Destroyed',
  blocks_placed: 'Blocks Placed',
  projectiles_fired: 'Projectiles Fired',
  powerups_collected: 'Powerups',
  vaults_used: 'Vaults Used',
  rounds_survived: 'Rounds Survived',
  maps_completed: 'Maps Completed',
  maps_completed_without_dying: 'Flawless Maps',
  goals: 'Goals',
  xp: 'XP'
}

/** Keys shown through a derived tile or the level bar instead of a raw one. */
const HIDDEN = new Set(['played', 'victories', 'kills', 'deaths', 'final_kills', 'xp', 'prestige', 'first_played', 'uncapped_xp'])

const ACCENT: Record<string, string> = {
  Wins: '#34d399',
  Losses: '#fb7185',
  'Win Rate': '#22d3ee',
  'Games Played': '#a2aabd',
  Kills: '#fbbf24',
  Deaths: '#fb7185',
  KDR: '#e9ecf6',
  'Final Kills': '#7c5cff',
  FKLR: '#f472b6'
}

export function StatCard({ card }: { card: Card }) {
  const info = game(card.game)
  const extras = Object.entries(card.stats).filter(([k, v]) => !HIDDEN.has(k) && typeof v === 'number')

  return (
    <div className="glass overflow-hidden" style={{ ['--c' as string]: info.color }}>
      <div
        className="flex flex-wrap items-center gap-4 px-6 py-5"
        style={{ background: `linear-gradient(160deg, color-mix(in oklab, ${info.color}, transparent 86%), transparent 70%)` }}
      >
        <GameTile short={info.short} color={info.color} />

        <div className="min-w-0">
          <h2 className="text-[clamp(18px,2.4vw,24px)] font-black tracking-[-0.04em]" style={{ color: info.color }}>
            {info.name}
          </h2>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12.5px] text-[var(--txt-3)]">
            {card.level && (
              <span className="text-[var(--txt-2)]">
                Level {card.level.level}
                {card.level.prestige > 0 && <b style={{ color: info.color }}> ★{card.level.prestige}</b>}
              </span>
            )}
            <span className="font-bold text-[var(--txt)]">{card.username}</span>
            {card.rank && (
              <span className="mono text-[11px] font-bold" style={{ color: 'var(--a1)' }}>
                [{card.rank}]
              </span>
            )}
            {card.monthly_rank !== null && <span>monthly rank #{num(card.monthly_rank)}</span>}
          </div>
        </div>

        <span className="mono ml-auto text-[11px] uppercase tracking-[0.11em] text-[var(--txt-3)]">
          {card.period === 'all' ? 'all time' : card.period}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-px sm:grid-cols-4" style={{ background: 'var(--line-2)' }}>
        <Tile label="Wins" value={num(card.stats.victories ?? 0)} />
        <Tile label="Losses" value={num(card.derived.losses)} />
        <Tile label="Win Rate" value={`${(card.derived.win_rate * 100).toFixed(card.derived.win_rate ? 1 : 0)}%`} />
        <Tile label="Games Played" value={num(card.stats.played ?? 0)} />

        {card.stats.kills !== undefined && <Tile label="Kills" value={num(card.stats.kills)} />}
        {card.stats.deaths !== undefined && <Tile label="Deaths" value={num(card.stats.deaths)} />}
        {card.derived.kdr !== null && <Tile label="KDR" value={card.derived.kdr.toFixed(2)} />}
        {card.stats.final_kills !== undefined && <Tile label="Final Kills" value={num(card.stats.final_kills)} />}
        {card.derived.fklr !== null && <Tile label="FKLR" value={card.derived.fklr.toFixed(2)} />}

        {extras.map(([k, v]) => (
          <Tile key={k} label={LABELS[k] ?? k.replace(/_/g, ' ')} value={num(v)} />
        ))}
      </div>

      <div className="space-y-4 px-6 py-5">
        {card.first_played && (
          <p className="text-center text-[12.5px] text-[var(--txt-3)]">
            First played <b className="font-semibold text-[var(--txt-2)]">{date(card.first_played * 1000)}</b>
          </p>
        )}

        {card.level ? (
          <LevelBar level={card.level} color={info.color} />
        ) : (
          <p className="text-center text-[11.5px] text-[var(--txt-3)]">
            {card.source === 'hive_month'
              ? "Month-to-date totals from Hive's monthly leaderboard."
              : 'Counted from what this tracker observed during the period — not a lifetime total.'}
          </p>
        )}
      </div>
    </div>
  )
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="kpi text-center">
      <b style={{ color: ACCENT[label] ?? 'var(--txt)' }}>{value}</b>
      <span>{label}</span>
    </div>
  )
}

function LevelBar({ level, color }: { level: Card['level'] & object; color: string }) {
  const SEGMENTS = 22
  const ratio = level.is_max ? 1 : Math.max(0, Math.min(1, level.xp_into_level / level.xp_for_level))
  const filled = Math.round(ratio * SEGMENTS)

  return (
    <div className="text-center">
      <div className="label">Level Progress</div>
      <div className="mono mt-1 text-[15px] font-bold text-[var(--txt-2)]">
        {num(level.xp_into_level)} / {num(level.xp_for_level)}
      </div>

      <div className="mt-2.5 flex flex-wrap items-center justify-center gap-2">
        <span className="mono text-[12px] font-bold" style={{ color }}>
          Level {level.level}
        </span>
        <span className="flex gap-[3px]">
          {Array.from({ length: SEGMENTS }, (_, i) => (
            <span
              key={i}
              className="h-3.5 w-2 rounded-[2px] transition-all"
              style={{
                background: i < filled ? color : 'rgba(255,255,255,.07)',
                boxShadow: i < filled ? `0 0 10px color-mix(in oklab, ${color}, transparent 55%)` : undefined
              }}
            />
          ))}
        </span>
        <span className="text-[12px] text-[var(--txt-3)]">
          {level.is_max ? 'Max Level' : `Level ${level.level + 1}`}
        </span>
      </div>

      {level.max_prestige > 0 && (
        <p className="mt-2 text-[11px] text-[var(--txt-3)]">
          Prestige {level.prestige} / {level.max_prestige}
        </p>
      )}
    </div>
  )
}
