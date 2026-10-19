import { config } from '../config.ts'
import { all, get, run } from '../db.ts'

/**
 * Rate-limit ledger.
 *
 * Two independent limits (measured, see docs/hive-api.md §3):
 *   - global: 120 req/min per IP           -> we cap ourselves at config.hive.globalPerMinute
 *   - per (player, game) bucket: 3 per 60 min, window anchored on the first request
 *
 * The ledger is the source of truth *before* a request goes out: we never fire a
 * request we already know will 429.
 */

export type BucketKey = string // `${uuid}:${game}` — game is a real id, or 'all' / 'main'

export function bucketKey(uuid: string, game: string): BucketKey {
  return `${uuid.toLowerCase()}:${game}`
}

/**
 * The very first request for a player is made by username (we do not know their UUID
 * yet), but Hive counts it against the same bucket as the UUID form. Re-key the ledger
 * entry as soon as the UUID is known, otherwise we would spend that slot twice.
 */
export function remapBucket(from: BucketKey, to: BucketKey, uuid: string): void {
  if (from === to) return
  run('UPDATE fetch_log SET bucket = ?, uuid = ? WHERE bucket = ?', [to, uuid, from])
  reserved.delete(from)
}

/** In-flight reservations, so two ticks cannot spend the same slot. */
const reserved = new Map<BucketKey, number>()

export function globalUsedLastMinute(now = Date.now()): number {
  const row = get<{ n: number }>('SELECT COUNT(*) AS n FROM fetch_log WHERE requested_at > ?', [now - 60_000])
  return row?.n ?? 0
}

export interface BucketState {
  /** Earliest time we may hit this bucket again. */
  nextAt: number
  /** Requests spent inside the current 60 min window. */
  used: number
  blockedUntil: number | null
}

export function bucketState(bucket: BucketKey, now = Date.now()): BucketState {
  const since = now - config.hive.bucketWindowMs
  const rows = all<{ requested_at: number; status: number; retry_after: number | null }>(
    'SELECT requested_at, status, retry_after FROM fetch_log WHERE bucket = ? AND requested_at > ? ORDER BY requested_at DESC',
    [bucket, since]
  )

  // A real 429 is authoritative: respect Retry-After to the second.
  let blockedUntil: number | null = null
  for (const r of rows) {
    if (r.status === 429 && r.retry_after) {
      const until = r.requested_at + r.retry_after * 1000
      if (until > now) blockedUntil = Math.max(blockedUntil ?? 0, until)
    }
  }

  const spent = rows.filter((r) => r.status !== 429)
  const used = spent.length
  const last = spent[0]?.requested_at ?? 0
  const reservedAt = reserved.get(bucket) ?? 0

  let nextAt = Math.max(last, reservedAt) + config.hive.bucketSpacingMs
  if (used >= config.hive.bucketQuota) {
    // Window is full: wait for the oldest request of the window to age out.
    const oldest = spent[spent.length - 1]!.requested_at
    nextAt = Math.max(nextAt, oldest + config.hive.bucketWindowMs + 1000)
  }
  if (blockedUntil) nextAt = Math.max(nextAt, blockedUntil)

  return { nextAt, used, blockedUntil }
}

export function canFetch(bucket: BucketKey, now = Date.now()): boolean {
  if (globalUsedLastMinute(now) >= config.hive.globalPerMinute) return false
  return bucketState(bucket, now).nextAt <= now
}

export function reserve(bucket: BucketKey, now = Date.now()): void {
  reserved.set(bucket, now)
}

/**
 * Lifetime counters.
 *
 * `fetch_log` is trimmed to three days, so counting its rows would only ever show a
 * rolling window. These keys survive every prune and answer "how many calls has this
 * tracker made since it was set up".
 */
export interface LifetimeCounters {
  requests: number
  errors: number
  since: number
}

function readCounter(key: string, fallback = 0): number {
  const row = get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key])
  return row ? Number(row.value) || 0 : fallback
}

function bump(key: string, by = 1): void {
  run(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(settings.value AS INTEGER) + ? AS TEXT)`,
    [key, String(by), by]
  )
}

export function lifetimeCounters(): LifetimeCounters {
  // First run after this feature landed: seed from whatever the log still holds rather
  // than pretending the tracker has never called anything.
  if (!get('SELECT value FROM settings WHERE key = ?', ['total_requests'])) {
    const known = get<{ n: number; first: number | null }>('SELECT COUNT(*) AS n, MIN(requested_at) AS first FROM fetch_log')
    bump('total_requests', known?.n ?? 0)
    bump('total_errors', get<{ n: number }>('SELECT COUNT(*) AS n FROM fetch_log WHERE status != 200')?.n ?? 0)
    run(
      `INSERT INTO settings (key, value) VALUES ('counting_since', ?) ON CONFLICT(key) DO NOTHING`,
      [String(known?.first ?? Date.now())]
    )
  }

  return {
    requests: readCounter('total_requests'),
    errors: readCounter('total_errors'),
    since: readCounter('counting_since', Date.now())
  }
}

export function logFetch(opts: {
  uuid: string | null
  bucket: BucketKey
  requestedAt: number
  status: number
  durationMs: number
  retryAfter?: number | null
}): void {
  run(
    'INSERT INTO fetch_log (uuid, bucket, requested_at, status, duration_ms, retry_after) VALUES (?, ?, ?, ?, ?, ?)',
    [opts.uuid, opts.bucket, opts.requestedAt, opts.status, opts.durationMs, opts.retryAfter ?? null]
  )
  lifetimeCounters() // seeds the keys on first use
  bump('total_requests')
  if (opts.status !== 200) bump('total_errors')
  reserved.delete(opts.bucket)
}

/** Trim the ledger: anything older than 3 days is only noise. */
export function pruneLedger(now = Date.now()): void {
  run('DELETE FROM fetch_log WHERE requested_at < ?', [now - 3 * 24 * 60 * 60 * 1000])
}
