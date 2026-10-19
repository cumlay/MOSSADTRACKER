import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

export interface StreamState {
  connected: boolean
  /** uuid -> timestamp of the last activity pushed by the server (drives the flash animation). */
  pulses: Record<string, number>
}

/** Live updates from the scheduler: every ingested fetch is pushed over SSE. */
export function useStream(): StreamState {
  const qc = useQueryClient()
  const [connected, setConnected] = useState(false)
  const [pulses, setPulses] = useState<Record<string, number>>({})

  useEffect(() => {
    const source = new EventSource('/api/stream')

    const refresh = (uuid?: string) => {
      void qc.invalidateQueries({ queryKey: ['players'] })
      void qc.invalidateQueries({ queryKey: ['status'] })
      if (uuid) void qc.invalidateQueries({ queryKey: ['player', uuid] })
    }

    source.addEventListener('hello', () => setConnected(true))
    source.addEventListener('player', (ev) => {
      const { uuid } = JSON.parse((ev as MessageEvent).data) as { uuid: string }
      refresh(uuid)
    })
    source.addEventListener('activity', (ev) => {
      const { uuid } = JSON.parse((ev as MessageEvent).data) as { uuid: string }
      setPulses((p) => ({ ...p, [uuid]: Date.now() }))
      refresh(uuid)
    })
    source.addEventListener('removed', () => refresh())
    source.onerror = () => setConnected(false)
    source.onopen = () => setConnected(true)

    return () => source.close()
  }, [qc])

  return { connected, pulses }
}
