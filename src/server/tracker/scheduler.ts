import { config } from '../config.ts'
import { all, get } from '../db.ts'
import { broadcast } from '../events.ts'
import { fetchAll, fetchGame, fetchMain } from '../hive/client.ts'
import { bucketKey, bucketState, globalUsedLastMinute, pruneLedger } from '../hive/limiter.ts'
import { hotGamesFor, ingestAll, ingestGame, ingestMain, refreshPlayerState } from './ingest.ts'
import { notifySessionStart } from '../notifier.ts'
import type { IngestResult } from './ingest.ts'
import type { Tier } from '../../shared/types.ts'

/**
 * The scheduler spends the per-(player, game) budget as evenly as possible.
 *
 * Each bucket is worth 3 requests/hour, so one request every 20 min. By rotating
 * between several buckets of the same player (all / main / their current game) with a
 * phase offset, we get an observation every ~7 min without ever exceeding a bucket.
 */

const INTERVAL = config.hive.bucketSpacingMs // 20 min

/** Which buckets we rotate through, per tier. */
function bucketsForTier(tier: Tier, uuid: string): string[] {
  switch (tier) {
    case 'hot': {
      const hot = hotGamesFor(uuid, 1)[0]
      return hot ? ['all', 'main', hot] : ['all', 'main']
    }
    case 'warm':
      return ['all', 'main']
    case 'cold':
      return ['all']
    case 'dormant':
      return ['all']
  }
}

function intervalForTier(tier: Tier): number {
  return tier === 'dormant' ? 60 * 60 * 1000 : INTERVAL
}

function lastFetchAt(bucket: string): number {
  const row = get<{ t: number | null }>(
    'SELECT MAX(requested_at) AS t FROM fetch_log WHERE bucket = ? AND status != 429',
    [bucket]
  )
  return row?.t ?? 0
}

/** Last time we observed this player at all, whichever bucket delivered it. */
function lastObservationAt(uuid: string): number {
  const row = get<{ t: number | null }>(
    'SELECT MAX(requested_at) AS t FROM fetch_log WHERE uuid = ? AND status != 429',
    [uuid]
  )
  return row?.t ?? 0
}

/**
 * When each of a player's buckets could next be spent, and when the player as a whole
 * is allowed to be observed again.
 *
 * Two independent gates:
 *   - per bucket: the ledger (20 min spacing + 3/hour quota);
 *   - per player: never two observations closer than one rotation step, so the
 *     observations stay spread out instead of clumping.
 *
 * Buckets are then served oldest-first. An earlier version pinned each bucket to a
 * fixed slot of the cycle, which meant a bucket whose ledger gate opened just after its
 * slot had to wait a whole extra cycle — that is where 23-minute gaps came from.
 */
function candidatesFor(uuid: string, tier: Tier, now: number): Array<{ bucket: string; dueAt: number; lastAt: number }> {
  const buckets = bucketsForTier(tier, uuid)
  const interval = intervalForTier(tier)
  const playerGate = lastObservationAt(uuid) + interval / buckets.length

  return buckets
    .map((bucket) => {
      const key = bucketKey(uuid, bucket)
      return {
        bucket,
        lastAt: lastFetchAt(key),
        dueAt: Math.max(bucketState(key, now).nextAt, playerGate)
      }
    })
    .sort((a, b) => a.dueAt - b.dueAt || a.lastAt - b.lastAt)
}

interface Candidate {
  uuid: string
  username: string
  bucket: string
  dueAt: number
}

/** One bucket per player, for every player due right now, most overdue first. */
export function plan(now = Date.now()): Candidate[] {
  const players = all<{ uuid: string; username: string; tier: Tier }>(
    'SELECT uuid, username, tier FROM players WHERE enabled = 1'
  )
  const out: Candidate[] = []

  for (const p of players) {
    // Oldest-first among the buckets that are actually allowed at this instant.
    const ready = candidatesFor(p.uuid, p.tier, now)
      .filter((c) => c.dueAt <= now)
      .sort((a, b) => a.lastAt - b.lastAt)

    const pick = ready[0]
    if (pick) out.push({ uuid: p.uuid, username: p.username, bucket: pick.bucket, dueAt: pick.dueAt })
  }

  return out.sort((a, b) => a.dueAt - b.dueAt)
}

/**
 * When this player's next data fetch will happen, and which bucket it will use.
 * This is what the UI counts down to — the honest "when do I learn something new".
 */
export function nextFetchFor(uuid: string, tier: Tier, now = Date.now()): { bucket: string; dueAt: number } {
  const best = candidatesFor(uuid, tier, now)[0]
  return best ? { bucket: best.bucket, dueAt: Math.max(now, best.dueAt) } : { bucket: 'all', dueAt: now }
}

/** Next planned fetch per player, for the status panel (does not filter on due). */
export function upcoming(now = Date.now(), limit = 20): Candidate[] {
  const players = all<{ uuid: string; username: string; tier: Tier }>(
    'SELECT uuid, username, tier FROM players WHERE enabled = 1'
  )
  return players
    .map((p) => ({ uuid: p.uuid, username: p.username, ...nextFetchFor(p.uuid, p.tier, now) }))
    .sort((a, b) => a.dueAt - b.dueAt)
    .slice(0, limit)
}

export async function fetchBucket(uuid: string, bucket: string): Promise<{ ok: boolean; changed: number; error?: string }> {
  const now = Date.now()

  if (bucket === 'all') {
    const res = await fetchAll(uuid)
    if (!res.ok) return { ok: false, changed: 0, error: res.error }
    const result = ingestAll(uuid, res.data, now)
    emit(uuid, result.changed.length > 0 || result.unknownActivity)
    void alert(uuid, result)
    return { ok: true, changed: result.changed.length }
  }

  if (bucket === 'main') {
    const res = await fetchMain(uuid)
    if (!res.ok) return { ok: false, changed: 0, error: res.error }
    const result = ingestMain(uuid, res.data, now)
    emit(uuid, result.unknownActivity)
    return { ok: true, changed: result.unknownActivity ? 1 : 0 }
  }

  const res = await fetchGame(uuid, bucket)
  if (!res.ok) return { ok: false, changed: 0, error: res.error }
  const result = ingestGame(uuid, bucket, res.data, now)
  emit(uuid, result.changed.length > 0)
  void alert(uuid, result)
  return { ok: true, changed: result.changed.length }
}

/** Fires outbound alerts for sessions that just opened. Never blocks the fetch loop. */
async function alert(uuid: string, result: IngestResult): Promise<void> {
  for (const start of result.sessionStarts) {
    if (start.matches > 0) await notifySessionStart({ uuid, gameId: start.game, ...start })
  }
}

function emit(uuid: string, activity: boolean): void {
  const row = get('SELECT * FROM players WHERE uuid = ?', [uuid])
  broadcast(activity ? 'activity' : 'player', { uuid, player: row })
}

let timer: NodeJS.Timeout | null = null
let busy = false
/** Hard cap on requests per tick, well under the 100/min budget. */
const MAX_PER_TICK = 6

async function tick(): Promise<void> {
  if (busy) return
  busy = true
  try {
    if (globalUsedLastMinute() >= config.hive.globalPerMinute) return
    const due = plan().slice(0, MAX_PER_TICK)
    for (const candidate of due) {
      const res = await fetchBucket(candidate.uuid, candidate.bucket)
      if (!res.ok && res.error !== 'rate_limited') {
        // 404 on a per-game bucket just means the player never touched that game.
        refreshPlayerState(candidate.uuid)
      }
    }
    if (Math.random() < 0.01) pruneLedger()
  } catch (err) {
    console.error('[scheduler] tick failed', err)
  } finally {
    busy = false
  }
}

export function startScheduler(): void {
  if (timer) return
  timer = setInterval(() => void tick(), config.scheduler.tickMs)
  void tick()
  console.log(`[scheduler] started, tick ${config.scheduler.tickMs / 1000}s`)
}

export function stopScheduler(): void {
  if (timer) clearTimeout(timer)
  timer = null
}

export function schedulerRunning(): boolean {
  return timer !== null
}
