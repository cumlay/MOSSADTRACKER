import { get, run } from './db.ts'
import { game } from '../shared/games.ts'

/**
 * Outbound alerts.
 *
 * The whole point of the watchlist is to be told when someone starts playing rather
 * than having to stare at the page, so alerts fire on *session start* — the moment a
 * player becomes active after a quiet stretch — not on every detection.
 */

export interface NotifySettings {
  webhook_url: string
  enabled: boolean
  /** Only alert for these games; empty means every game. */
  games: string[]
}

const DEFAULTS: NotifySettings = { webhook_url: '', enabled: false, games: [] }

export function getSettings(): NotifySettings {
  const row = get<{ value: string }>("SELECT value FROM settings WHERE key = 'notify'")
  if (!row) return DEFAULTS
  try {
    return { ...DEFAULTS, ...(JSON.parse(row.value) as Partial<NotifySettings>) }
  } catch {
    return DEFAULTS
  }
}

export function saveSettings(next: Partial<NotifySettings>): NotifySettings {
  const merged = { ...getSettings(), ...next }
  run(
    `INSERT INTO settings (key, value) VALUES ('notify', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [JSON.stringify(merged)]
  )
  return merged
}

interface SessionAlert {
  uuid: string
  gameId: string
  matches: number
  /** Uncertainty window of the detection that opened the session. */
  windowStart: number
  windowEnd: number
}

export async function notifySessionStart(alert: SessionAlert): Promise<boolean> {
  const settings = getSettings()
  if (!settings.enabled || !settings.webhook_url) return false
  if (settings.games.length > 0 && !settings.games.includes(alert.gameId)) return false

  const player = get<{ username: string; username_cc: string | null; notify: number }>(
    'SELECT username, username_cc, notify FROM players WHERE uuid = ?',
    [alert.uuid]
  )
  if (!player || player.notify === 0) return false

  const name = player.username_cc ?? player.username
  const info = game(alert.gameId)
  const clock = (ts: number) => new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

  const body = {
    username: 'ninjaTracker',
    embeds: [
      {
        title: `${name} is playing`,
        description: `**${info.name}** · ${alert.matches} match${alert.matches > 1 ? 'es' : ''} detected`,
        color: parseInt(info.color.slice(1), 16),
        footer: {
          // Never imply more precision than the polling interval gives us.
          text: `between ${clock(alert.windowStart)} and ${clock(alert.windowEnd)}`
        },
        timestamp: new Date(alert.windowEnd).toISOString()
      }
    ]
  }

  try {
    const res = await fetch(settings.webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    return res.ok
  } catch {
    return false
  }
}

/** Sends a sample alert so the user can confirm the webhook works. */
export async function sendTestAlert(): Promise<boolean> {
  const settings = getSettings()
  if (!settings.webhook_url) return false
  try {
    const res = await fetch(settings.webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'ninjaTracker',
        content: 'Test alert — ninjaTracker can reach this webhook.'
      })
    })
    return res.ok
  } catch {
    return false
  }
}
