import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api.ts'
import type { BotSettings } from '../../shared/types.ts'

type Flag = 'session_start' | 'session_end' | 'milestones' | 'inactivity' | 'daily_report' | 'weekly_report'

const FLAGS: Array<{ key: Flag; label: string; hint: string }> = [
  { key: 'session_start', label: 'Online', hint: 'when someone starts playing' },
  { key: 'session_end', label: 'Session summary', hint: 'duration, matches, wins, level-ups' },
  { key: 'milestones', label: 'Milestones', hint: 'every 5th level, prestige, win streaks' },
  { key: 'inactivity', label: 'Inactivity', hint: 'once, when someone goes quiet' },
  { key: 'daily_report', label: 'Daily report', hint: 'yesterday, every morning' },
  { key: 'weekly_report', label: 'Weekly report', hint: 'last week, on Mondays' }
]

/** What the Discord bot posts on its own, and the limits for limited accounts. */
export function BotSettingsPanel() {
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['bot-settings'], queryFn: api.botSettings })
  const save = useMutation({
    mutationFn: (s: Partial<BotSettings>) => api.saveBotSettings(s),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['bot-settings'] })
      void qc.invalidateQueries({ queryKey: ['players'] })
    }
  })

  if (!data) return null
  const s = data.settings

  return (
    <div className="glass card-pad p-5">
      <div className="label mb-1">Discord bot</div>
      {!data.bot && (
        <p className="mb-2 text-[11px] leading-relaxed" style={{ color: 'var(--warn)' }}>
          No bot token is configured, so nothing is posted yet.
        </p>
      )}

      <div className="mt-2 space-y-1">
        {FLAGS.map((f) => (
          <label key={f.key} className="flex cursor-pointer items-center gap-2.5 rounded-[10px] px-1 py-1 text-[12.5px] hover:bg-white/[0.04]">
            <input type="checkbox" checked={s[f.key]} onChange={(e) => save.mutate({ [f.key]: e.target.checked })} className="accent-[var(--a1)]" />
            <span className="font-semibold">{f.label}</span>
            <span className="ml-auto text-right text-[10.5px] text-[var(--txt-3)]">{f.hint}</span>
          </label>
        ))}
      </div>

      <div className="mt-3 grid gap-2 border-t border-[var(--line-2)] pt-3 text-[12px]">
        <NumberField label="Reports at" suffix=":00" value={s.report_hour} min={0} max={23} onSave={(v) => save.mutate({ report_hour: v })} />
        <NumberField
          label="Inactive after"
          suffix="days"
          value={s.inactive_days}
          min={2}
          max={90}
          onSave={(v) => save.mutate({ inactive_days: v })}
        />
        <NumberField
          label="Tracker user limit"
          suffix="players each"
          value={s.user_add_limit}
          min={0}
          max={100}
          onSave={(v) => save.mutate({ user_add_limit: v })}
        />
      </div>
      <p className="mt-2 text-[10.5px] leading-relaxed text-[var(--txt-3)]">
        Inactive players are checked every 2 hours instead of every 20 minutes, to save Hive requests. Muted players never
        trigger any of these posts.
      </p>
    </div>
  )
}

function NumberField({
  label,
  suffix,
  value,
  min,
  max,
  onSave
}: {
  label: string
  suffix: string
  value: number
  min: number
  max: number
  onSave: (v: number) => void
}) {
  return (
    <label className="flex items-center gap-2">
      <span className="text-[var(--txt-2)]">{label}</span>
      <input
        key={value}
        type="number"
        min={min}
        max={max}
        defaultValue={value}
        onBlur={(e) => {
          const v = Number(e.target.value)
          if (Number.isFinite(v) && v !== value) onSave(v)
        }}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        className="glass-well mono ml-auto w-16 px-2 py-1 text-right text-[12px] outline-none"
      />
      <span className="w-[86px] text-[11px] text-[var(--txt-3)]">{suffix}</span>
    </label>
  )
}
