import { get, run } from './db.ts'
import { getBotSettings } from './settings.ts'
import { liveCompanions } from './insights.ts'
import { BRAND, sessionStartEmbed, type Embed } from './embeds.ts'

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

/** Discord embed object, shared by the webhook and the bot. */
export type AlertEmbed = Embed

/**
 * Where the bot posts — it registers itself here when it connects. A hook rather than
 * an import: the bot depends on the scheduler, which depends on this file.
 * `channelId` null means the default alert channel.
 */
type AlertSink = (embed: AlertEmbed, channelId: string | null) => Promise<boolean>
let sink: AlertSink | null = null

export function setAlertSink(next: AlertSink | null): void {
  sink = next
}

export function hasAlertSink(): boolean {
  return sink !== null
}

/**
 * Posts through the bot. With a player, their group's channel wins over the default
 * one, so each clan's alerts can live in their own channel.
 */
export async function postAlert(embed: AlertEmbed, uuid: string | null = null): Promise<boolean> {
  if (!sink) return false
  const channel = uuid
    ? (get<{ channel_id: string | null }>(
        'SELECT g.channel_id FROM players p JOIN player_groups g ON g.id = p.group_id WHERE p.uuid = ?',
        [uuid]
      )?.channel_id ?? null)
    : null
  return sink(embed, channel).catch(() => false)
}

export async function notifySessionStart(alert: SessionAlert): Promise<boolean> {
  const settings = getSettings()
  const toWebhook = settings.enabled && settings.webhook_url !== ''
  const toBot = sink !== null && getBotSettings().session_start
  if (!toWebhook && !toBot) return false
  if (settings.games.length > 0 && !settings.games.includes(alert.gameId)) return false

  const player = get<{ username: string; username_cc: string | null; notify: number }>(
    'SELECT username, username_cc, notify FROM players WHERE uuid = ?',
    [alert.uuid]
  )
  if (!player || player.notify === 0) return false

  // The session that just opened is the latest; the one before tells how long they were away.
  const previous = get<{ ended_at: number }>('SELECT ended_at FROM sessions WHERE uuid = ? ORDER BY ended_at DESC LIMIT 1 OFFSET 1', [
    alert.uuid
  ])
  const away = previous ? alert.windowStart - previous.ended_at : null
  const longAway = away !== null && away >= getBotSettings().inactive_days * 86_400_000 ? away : null

  const embed = sessionStartEmbed(player.username_cc ?? player.username, alert, {
    with: liveCompanions(alert.uuid, alert.gameId, alert.windowEnd),
    backAfterMs: longAway
  })
  const sent = await Promise.all([
    toWebhook ? postWebhook(settings.webhook_url, { username: BRAND, embeds: [embed] }) : false,
    toBot ? postAlert(embed, alert.uuid) : false
  ])
  return sent.some(Boolean)
}

async function postWebhook(url: string, body: unknown): Promise<boolean> {
  try {
    const res = await fetch(url, {
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
        username: BRAND,
        content: `Test alert — ${BRAND} can reach this webhook.`
      })
    })
    return res.ok
  } catch {
    return false
  }
}
