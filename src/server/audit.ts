import { all, run } from './db.ts'
import type { AuditEntry } from '../shared/types.ts'

/**
 * Who did what to the watchlist. Every change goes through the services, which record
 * it here, so the website and Discord end up in one log.
 */

export interface Actor {
  /** Website account name when known, otherwise the Discord username. */
  name: string
  source: 'web' | 'discord' | 'system'
  /** "full" = the tracker permission; "user" = trackerUser (view + add). */
  access: 'full' | 'user'
}

export const SYSTEM: Actor = { name: 'system', source: 'system', access: 'full' }

export function audit(
  actor: Actor,
  action: string,
  target: { uuid: string; name: string } | null = null,
  detail: string | null = null
): void {
  run('INSERT INTO audit_log (at, actor, source, action, target_uuid, target_name, detail) VALUES (?, ?, ?, ?, ?, ?, ?)', [
    Date.now(),
    actor.name,
    actor.source,
    action,
    target?.uuid ?? null,
    target?.name ?? null,
    detail
  ])
}

export function auditLog(limit = 200, before?: number): AuditEntry[] {
  return all<AuditEntry>(
    `SELECT id, at, actor, source, action, target_uuid, target_name, detail FROM audit_log
     WHERE id < ? ORDER BY id DESC LIMIT ?`,
    [before ?? Number.MAX_SAFE_INTEGER, Math.min(500, Math.max(1, limit))]
  )
}
