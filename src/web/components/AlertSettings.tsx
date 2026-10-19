import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api.ts'

/**
 * Discord webhook configuration.
 *
 * Alerts fire when a player *starts* a session, not on every detection — the point is
 * to be told someone came online, not to be pinged for each match they finish.
 */
export function AlertSettings() {
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['settings'], queryFn: api.settings })
  const [url, setUrl] = useState('')
  const [feedback, setFeedback] = useState<string | null>(null)

  useEffect(() => {
    if (data?.notify.webhook_url !== undefined) setUrl(data.notify.webhook_url)
  }, [data?.notify.webhook_url])

  const save = useMutation({
    mutationFn: (body: Parameters<typeof api.saveSettings>[0]) => api.saveSettings(body),
    onSuccess: () => {
      setFeedback('Saved.')
      void qc.invalidateQueries({ queryKey: ['settings'] })
    }
  })

  const test = useMutation({
    mutationFn: api.testAlert,
    onSuccess: () => setFeedback('Test alert sent — check your Discord channel.'),
    onError: () => setFeedback('Discord refused the request. Check the webhook URL.')
  })

  const enabled = data?.notify.enabled ?? false

  return (
    <div className="glass card-pad p-5">
      <div className="mb-3 flex items-center justify-between">
        <div className="label">Alerts</div>
        <button
          onClick={() => save.mutate({ enabled: !enabled })}
          className="rounded-full px-2.5 py-0.5 text-[11px] font-semibold transition-colors"
          style={
            enabled
              ? { color: 'var(--ok)', background: 'color-mix(in oklab, var(--ok), transparent 88%)' }
              : { color: 'var(--txt-3)', background: 'rgba(255,255,255,.05)' }
          }
        >
          {enabled ? 'on' : 'off'}
        </button>
      </div>

      <p className="mb-3 text-[11.5px] leading-relaxed text-[var(--txt-3)]">
        Sends a Discord message when a tracked player starts playing.
      </p>

      <input
        value={url}
        onChange={(e) => {
          setUrl(e.target.value)
          setFeedback(null)
        }}
        placeholder="https://discord.com/api/webhooks/…"
        className="glass-well w-full px-4 py-2 text-[12.5px] outline-none transition-colors placeholder:text-[var(--txt-3)] focus:border-[color-mix(in_oklab,var(--a1),transparent_55%)]"
      />

      <div className="mt-2 flex gap-2">
        <button className="btn" disabled={save.isPending} onClick={() => save.mutate({ webhook_url: url.trim() })}>
          Save
        </button>
        <button className="btn btn--ghost" disabled={!url.trim() || test.isPending} onClick={() => test.mutate()}>
          Send test
        </button>
      </div>

      {feedback && <p className="mt-2 text-[11.5px] text-[var(--txt-2)]">{feedback}</p>}

      {data && (
        <p className="mt-3 border-t border-[var(--line-2)] pt-3 text-[11px] text-[var(--txt-3)]">
          Raw API snapshots are kept for {data.snapshot_retention_days} days; the counters, sessions and
          history derived from them are kept for good.
        </p>
      )}
    </div>
  )
}
