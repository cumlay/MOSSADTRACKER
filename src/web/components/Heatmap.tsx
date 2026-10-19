const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/**
 * 7 x 24 presence grid. Values are minutes of *observed* activity, spread across the
 * uncertainty window of each detection — so it shows habits, not exact timestamps.
 */
export function Heatmap({ grid }: { grid: number[][] }) {
  const max = Math.max(1, ...grid.flat())
  const total = grid.flat().reduce((a, b) => a + b, 0)

  if (total === 0) {
    return (
      <p className="text-xs text-[var(--txt-3)]">
        Not enough observations yet. The grid fills in as the tracker detects matches.
      </p>
    )
  }

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[560px]">
        <div className="mb-1 flex gap-[3px] pl-9">
          {Array.from({ length: 24 }, (_, h) => (
            <div key={h} className="w-[18px] text-center text-[9px] text-[var(--txt-3)]">
              {h % 3 === 0 ? h : ''}
            </div>
          ))}
        </div>
        {grid.map((row, d) => (
          <div key={d} className="mb-[3px] flex items-center gap-[3px]">
            <div className="w-9 text-[10px] text-[var(--txt-3)]">{DAYS[d]}</div>
            {row.map((v, h) => {
              const intensity = v / max
              return (
                <div
                  key={h}
                  title={`${DAYS[d]} ${String(h).padStart(2, '0')}h — ${Math.round(v)} min detected`}
                  className="h-[18px] w-[18px] rounded-[3px] transition-transform hover:scale-110"
                  style={{
                    backgroundColor: v === 0 ? 'rgba(255,255,255,0.035)' : `rgba(124, 92, 255, ${0.18 + intensity * 0.82})`,
                    boxShadow: intensity > 0.6 ? '0 0 12px rgba(124,92,255,.35)' : undefined
                  }}
                />
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}
