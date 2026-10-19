import { existsSync } from 'node:fs'
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { config } from './config.ts'
import { all, get, run } from './db.ts'
import { addClient, broadcast } from './events.ts'
import { searchPlayers } from './hive/client.ts'
import { bucketKey, bucketState, globalUsedLastMinute, lifetimeCounters } from './hive/limiter.ts'
import { getPlayer, history, listPlayers, playerDetail } from './queries.ts'
import { trackPlayer, untrackPlayer } from './services/players.ts'
import { startBot } from './bot/index.ts'
import { fetchBucket, schedulerRunning, startScheduler, upcoming } from './tracker/scheduler.ts'
import { refreshOfficialMonth } from './tracker/monthly.ts'
import { statCard } from './stats.ts'
import { getSettings, saveSettings, sendTestAlert } from './notifier.ts'
import { pruneSnapshots, purgeRetiredGames, refreshAllPlayers, SNAPSHOT_RETENTION_MS } from './maintenance.ts'
import { backfillMonthly, scheduleBackfill } from './tracker/backfill.ts'
import type { SearchResult } from '../shared/types.ts'

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'warn' } })

/**
 * Treat an empty JSON body as "no body" instead of rejecting the request.
 *
 * Clients routinely send `Content-Type: application/json` on a DELETE with nothing to
 * send; Fastify's default parser answers 400, which fails silently in a UI that only
 * checks for a thrown error.
 */
app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
  const raw = typeof body === 'string' ? body.trim() : ''
  if (raw === '') return done(null, undefined)
  try {
    done(null, JSON.parse(raw))
  } catch (err) {
    done(err as Error, undefined)
  }
})

/* ------------------------------------------------------------------ players */

app.get('/api/players', async () => ({ players: listPlayers() }))

app.get<{ Params: { uuid: string } }>('/api/players/:uuid', async (req, reply) => {
  const detail = playerDetail(req.params.uuid)
  if (!detail) return reply.code(404).send({ error: 'not_tracked' })
  return detail
})

app.post<{ Body: { identifier?: string } }>('/api/players', async (req, reply) => {
  const identifier = req.body?.identifier?.trim()
  if (!identifier) return reply.code(400).send({ error: 'identifier_required' })

  const result = await trackPlayer(identifier)
  if (result.ok) return reply.code(201).send({ player: result.player })

  const status =
    result.reason === 'not_found' ? 404 : result.reason === 'already_tracked' ? 409 : result.reason === 'rate_limited' ? 429 : 502
  return reply.code(status).send({ error: result.reason, retryAfter: result.retryAfter, uuid: result.uuid })
})

app.delete<{ Params: { uuid: string } }>('/api/players/:uuid', async (req) => {
  untrackPlayer(req.params.uuid)
  return { ok: true }
})

app.patch<{ Params: { uuid: string }; Body: { enabled?: boolean; notify?: boolean } }>('/api/players/:uuid', async (req) => {
  if (typeof req.body?.enabled === 'boolean') {
    run('UPDATE players SET enabled = ? WHERE uuid = ?', [req.body.enabled ? 1 : 0, req.params.uuid])
  }
  if (typeof req.body?.notify === 'boolean') {
    run('UPDATE players SET notify = ? WHERE uuid = ?', [req.body.notify ? 1 : 0, req.params.uuid])
  }
  const player = getPlayer(req.params.uuid)
  broadcast('player', { uuid: req.params.uuid, player })
  return { player }
})

/** Manual refresh — respects the ledger and tells the UI when the bucket reopens. */
app.post<{ Params: { uuid: string }; Body: { bucket?: string } }>('/api/players/:uuid/refresh', async (req, reply) => {
  const bucket = req.body?.bucket ?? 'all'
  const key = bucketKey(req.params.uuid, bucket)
  const state = bucketState(key)
  if (state.nextAt > Date.now()) {
    return reply.code(429).send({ error: 'bucket_cooldown', nextAt: state.nextAt, used: state.used })
  }
  const res = await fetchBucket(req.params.uuid, bucket)
  return { ...res, player: getPlayer(req.params.uuid) }
})

app.get<{ Params: { uuid: string }; Querystring: { period?: string; count?: string } }>(
  '/api/players/:uuid/history',
  async (req, reply) => {
    const period = req.query.period === 'week' || req.query.period === 'month' ? req.query.period : 'day'
    const count = Math.min(60, Math.max(3, Number(req.query.count ?? (period === 'day' ? 14 : period === 'week' ? 12 : 6))))

    if (!getPlayer(req.params.uuid)) return reply.code(404).send({ error: 'not_tracked' })
    // Opening the month view is what triggers the (cached, budget-aware) official refresh.
    if (period === 'month') await refreshOfficialMonth(req.params.uuid)

    return history(req.params.uuid, period, count)
  }
)

app.get<{ Params: { uuid: string; game: string }; Querystring: { period?: string } }>(
  '/api/stats/:uuid/:game',
  async (req, reply) => {
    const raw = req.query.period
    const period = raw === 'day' || raw === 'week' || raw === 'month' ? raw : 'all'
    if (period === 'month') await refreshOfficialMonth(req.params.uuid)

    const card = await statCard(req.params.uuid, req.params.game, period)
    if (!card) return reply.code(404).send({ error: 'no_stats' })
    return card
  }
)

/* ------------------------------------------------------------------- search */

app.get<{ Querystring: { q?: string } }>('/api/search', async (req, reply) => {
  const q = (req.query.q ?? '').trim()
  if (q.length < 4) return reply.code(400).send({ error: 'min_4_chars' })

  const res = await searchPlayers(q)
  if (!res.ok) return reply.code(502).send({ error: res.error })

  const tracked = new Set(all<{ uuid: string }>('SELECT uuid FROM players').map((r) => r.uuid))
  const results: SearchResult[] = res.data.slice(0, 25).map((hit) => ({
    uuid: hit.UUID,
    username: hit.username,
    username_cc: hit.username_cc,
    tracked: tracked.has(hit.UUID)
  }))
  return { results }
})

/** Rebuilds monthly history from the leaderboards. Costs no per-player budget. */
app.post<{ Body: { months?: number } }>('/api/backfill', async (req) => {
  const months = Math.min(24, Math.max(1, Number(req.body?.months ?? 6)))
  return backfillMonthly(months)
})

/* ----------------------------------------------------------------- settings */

app.get('/api/settings', async () => ({ notify: getSettings(), snapshot_retention_days: SNAPSHOT_RETENTION_MS / 86400000 }))

app.put<{ Body: { webhook_url?: string; enabled?: boolean; games?: string[] } }>('/api/settings', async (req) => ({
  notify: saveSettings(req.body ?? {})
}))

app.post('/api/settings/test', async (_req, reply) => {
  const ok = await sendTestAlert()
  return ok ? { ok } : reply.code(502).send({ error: 'webhook_failed' })
})

/* ------------------------------------------------------------------- status */

app.get('/api/status', async () => {
  const now = Date.now()
  return {
    running: schedulerRunning(),
    tick_ms: config.scheduler.tickMs,
    global_used_last_minute: globalUsedLastMinute(now),
    global_limit: config.hive.globalPerMinute,
    lifetime: lifetimeCounters(),
    next_fetches: upcoming(now).map((c) => ({ uuid: c.uuid, username: c.username, bucket: c.bucket, due_at: c.dueAt })),
    recent_fetches: all<{ uuid: string | null; bucket: string; requested_at: number; status: number; duration_ms: number }>(
      'SELECT uuid, bucket, requested_at, status, duration_ms FROM fetch_log ORDER BY requested_at DESC LIMIT 30'
    ).map((f) => ({ uuid: f.uuid, bucket: f.bucket, at: f.requested_at, status: f.status, ms: f.duration_ms }))
  }
})

/* ---------------------------------------------------------------------- SSE */

app.get('/api/stream', (req, reply) => {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  })
  reply.raw.write(`event: hello\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`)
  addClient(reply)
  const keepAlive = setInterval(() => reply.raw.write(': ping\n\n'), 25_000)
  reply.raw.on('close', () => clearInterval(keepAlive))
})

/* ------------------------------------------------------------------ web app */

if (existsSync(config.webDist)) {
  await app.register(fastifyStatic, { root: config.webDist })
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api')) return reply.code(404).send({ error: 'not_found' })
    return reply.sendFile('index.html')
  })
}

/* -------------------------------------------------------------- housekeeping */

const purged = purgeRetiredGames()
if (Object.keys(purged).length > 0) console.log('[maintenance] purged retired games', purged)

const logPrune = () => {
  const n = pruneSnapshots()
  if (n > 0) console.log(`[maintenance] dropped ${n} raw snapshots past retention`)
}
logPrune()
setInterval(logPrune, 60 * 60 * 1000)

// Derived columns are recomputed at boot so a rule change takes effect immediately.
refreshAllPlayers()

const address = await app.listen({ port: config.port, host: config.host })
console.log(`[ninjaTracker] API on ${address}`)
startScheduler()
scheduleBackfill()
startBot()
