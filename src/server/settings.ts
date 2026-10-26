import { get, run } from './db.ts'
import type { BotSettings } from '../shared/types.ts'

/**
 * What the Discord bot posts on its own, and the limits on limited accounts.
 *
 * Stored as one JSON row; every field has a default, so a database from before a
 * field existed simply reads the default.
 */

export const BOT_DEFAULTS: BotSettings = {
  session_start: true,
  session_end: true,
  milestones: true,
  inactivity: true,
  daily_report: true,
  weekly_report: true,
  report_hour: 9,
  inactive_days: 7,
  user_add_limit: 5
}

const FLAGS = ['session_start', 'session_end', 'milestones', 'inactivity', 'daily_report', 'weekly_report'] as const
const NUMBERS: Record<'report_hour' | 'inactive_days' | 'user_add_limit', [number, number]> = {
  report_hour: [0, 23],
  inactive_days: [2, 90],
  user_add_limit: [0, 100]
}

export function getBotSettings(): BotSettings {
  const row = get<{ value: string }>("SELECT value FROM settings WHERE key = 'bot'")
  if (!row) return { ...BOT_DEFAULTS }
  try {
    return { ...BOT_DEFAULTS, ...(JSON.parse(row.value) as Partial<BotSettings>) }
  } catch {
    return { ...BOT_DEFAULTS }
  }
}

/** Merges the known fields of `input`, clamping numbers; anything else is ignored. */
export function saveBotSettings(input: Record<string, unknown>): BotSettings {
  const next = getBotSettings()
  for (const k of FLAGS) {
    if (typeof input[k] === 'boolean') next[k] = input[k] as boolean
  }
  for (const [k, [min, max]] of Object.entries(NUMBERS) as Array<[keyof typeof NUMBERS, [number, number]]>) {
    const v = Number(input[k])
    if (input[k] !== undefined && Number.isFinite(v)) next[k] = Math.min(max, Math.max(min, Math.round(v)))
  }
  run(
    `INSERT INTO settings (key, value) VALUES ('bot', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [JSON.stringify(next)]
  )
  return next
}

/** Per-sweep state (last report sent…), kept next to the settings. */
export function getMark(key: string): string | null {
  return get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [`mark:${key}`])?.value ?? null
}

export function setMark(key: string, value: string): void {
  run(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [`mark:${key}`, value]
  )
}
