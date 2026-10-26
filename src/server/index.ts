import { existsSync } from 'node:fs'
import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from 'fastify'
import fastifyStatic from '@fastify/static'
import { config } from './config.ts'
import { all, get, run } from './db.ts'
import { addClient, broadcast } from './events.ts'
import { searchPlayers } from './hive/client.ts'
import { bucketKey, bucketState, globalUsedLastMinute, lifetimeCounters } from './hive/limiter.ts'
import { getPlayer, history, listPlayers, playerDetail } from './queries.ts'
import { addedBy, addLimit, setPlayerFlags, trackPlayer, untrackPlayer } from './services/players.ts'
import { addNote, createGroup, deleteGroup, deleteNote, InputError, listGroups, setGroup, setTags, updateGroup } from './services/organise.ts'
import { audit, auditLog, type Actor } from './audit.ts'
import { getBotSettings, saveBotSettings } from './settings.ts'
import { sessionsCsv, statsCsv, timeline } from './insights.ts'
import { startAlertLoop } from './alerts.ts'
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

/* ------------------------------------------------------------------- access */

/**
 * Access level, set by nginx from the corlay account check: "full" for the tracker
 * permission, "user" for trackerUser. nginx always overwrites the header, so a client
 * cannot raise its own level; when it is missing the request gets the limited level.
 * The Vite dev proxy sends "full".
 */
type Access = 'full' | 'user'
const accessOf = (req: FastifyRequest): Access => (req.headers['x-tracker-access'] === 'full' ? 'full' : 'user')

/** What a "user" may change: adding a player, nothing else. */
const USER_WRITES = new Set(['POST /api/players'])

app.addHook('onRequest', async (req, reply) => {
  if (req.method === 'GET' || req.method === 'HEAD' || accessOf(req) === 'full') return
  if (!USER_WRITES.has(`${req.method} ${req.routeOptions.url}`)) return reply.code(403).send({ error: 'forbidden' })
})

/** Account name nginx passes along; "local" in development, where there is no account. */
const actorOf = (req: FastifyRequest): Actor => {
  const raw = req.headers['x-tracker-user']
  const name = typeof raw === 'string' && /^[A-Za-z0-9_.-]{1,32}$/.test(raw) ? raw : 'local'
  return { name, source: 'web', access: accessOf(req) }
}

const fullOnly = (req: FastifyRequest, reply: FastifyReply) => {
  if (accessOf(req) === 'full') return false
  void reply.code(403).send({ error: 'forbidden' })
  return true
}

/** Validation errors from the services become 400s with their message. */
app.setErrorHandler((err: FastifyError, _req, reply) => {
  if (err instanceof InputError) return reply.code(400).send({ error: err.message })
  reply.log.error(err)
  return reply.code(err.statusCode ?? 500).send({ error: err.statusCode && err.statusCode < 500 ? err.message : 'server_error' })
})

app.get('/api/me', async (req) => {
  const actor = actorOf(req)
  return { access: actor.access, name: actor.name, added: addedBy(actor.name), limit: addLimit(actor) }
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

  const result = await trackPlayer(identifier, actorOf(req))
  if (result.ok) return reply.code(201).send({ player: result.player })

  const status =
    result.reason === 'not_found'
      ? 404
      : result.reason === 'already_tracked'
        ? 409
        : result.reason === 'rate_limited'
          ? 429
          : result.reason === 'limit'
            ? 403
            : 502
  return reply.code(status).send({ error: result.reason, retryAfter: result.retryAfter, uuid: result.uuid, limit: result.limit })
})

app.delete<{ Params: { uuid: string } }>('/api/players/:uuid', async (req) => {
  untrackPlayer(req.params.uuid, actorOf(req))
  return { ok: true }
})

app.patch<{
  Params: { uuid: string }
  Body: { enabled?: boolean; notify?: boolean; tags?: unknown; group_id?: number | null }
}>('/api/players/:uuid', async (req, reply) => {
  const actor = actorOf(req)
  const body = req.body ?? {}
  let player = setPlayerFlags(req.params.uuid, { enabled: body.enabled, notify: body.notify }, actor)
  if (!player) return reply.code(404).send({ error: 'not_tracked' })
  if (body.tags !== undefined) player = setTags(req.params.uuid, body.tags, actor)
  if (body.group_id !== undefined) player = setGroup(req.params.uuid, body.group_id === null ? null : Number(body.group_id), actor)
  return { player }
})

app.post<{ Params: { uuid: string }; Body: { body?: string } }>('/api/players/:uuid/notes', async (req, reply) => {
  const note = addNote(req.params.uuid, req.body?.body, actorOf(req))
  return note ? reply.code(201).send({ note }) : reply.code(404).send({ error: 'not_tracked' })
})

app.delete<{ Params: { uuid: string; id: string } }>('/api/players/:uuid/notes/:id', async (req, reply) => {
  return deleteNote(req.params.uuid, Number(req.params.id), actorOf(req)) ? { ok: true } : reply.code(404).send({ error: 'not_found' })
})

app.get<{ Params: { uuid: string }; Querystring: { days?: string } }>('/api/players/:uuid/timeline', async (req, reply) => {
  if (!getPlayer(req.params.uuid)) return reply.code(404).send({ error: 'not_tracked' })
  const days = Math.min(180, Math.max(7, Number(req.query.days ?? 56) || 56))
  return { days, sessions: timeline(req.params.uuid, days) }
})

/** CSV downloads: sessions or per-game stats. */
app.get<{ Params: { uuid: string; kind: string } }>('/api/players/:uuid/export/:kind', async (req, reply) => {
  const p = getPlayer(req.params.uuid)
  if (!p) return reply.code(404).send({ error: 'not_tracked' })
  const kind = req.params.kind.replace(/\.csv$/, '')
  if (kind !== 'sessions' && kind !== 'stats') return reply.code(404).send({ error: 'not_found' })
  const file = `${p.username.replace(/[^A-Za-z0-9_-]+/g, '_')}-${kind}.csv`
  return reply
    .header('Content-Type', 'text/csv; charset=utf-8')
    .header('Content-Disposition', `attachment; filename="${file}"`)
    .send(kind === 'sessions' ? sessionsCsv(p.uuid) : statsCsv(p.uuid))
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

/* ------------------------------------------------------------------- groups */

app.get('/api/groups', async () => ({ groups: listGroups() }))

app.post<{ Body: Record<string, unknown> }>('/api/groups', async (req, reply) => reply.code(201).send({ group: createGroup(req.body ?? {}, actorOf(req)) }))

app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/groups/:id', async (req, reply) => {
  const group = updateGroup(Number(req.params.id), req.body ?? {}, actorOf(req))
  return group ? { group } : reply.code(404).send({ error: 'not_found' })
})

app.delete<{ Params: { id: string } }>('/api/groups/:id', async (req, reply) =>
  deleteGroup(Number(req.params.id), actorOf(req)) ? { ok: true } : reply.code(404).send({ error: 'not_found' })
)

/* -------------------------------------------------------------------- audit */

app.get<{ Querystring: { limit?: string; before?: string } }>('/api/audit', async (req, reply) => {
  if (fullOnly(req, reply)) return reply
  return { entries: auditLog(Number(req.query.limit ?? 200) || 200, req.query.before ? Number(req.query.before) : undefined) }
})

/* -------------------------------------------------------------- bot settings */

app.get('/api/bot-settings', async (req, reply) => {
  if (fullOnly(req, reply)) return reply
  return { settings: getBotSettings(), bot: Boolean(process.env.DISCORD_TOKEN) }
})

app.put<{ Body: Record<string, unknown> }>('/api/bot-settings', async (req) => {
  const before = getBotSettings()
  const settings = saveBotSettings(req.body ?? {})
  const diff = (Object.keys(settings) as Array<keyof typeof settings>)
    .filter((k) => settings[k] !== before[k])
    .map((k) => `${k}: ${before[k]} → ${settings[k]}`)
  if (diff.length > 0) audit(actorOf(req), 'settings', null, diff.join(', '))
  return { settings }
})

/* ----------------------------------------------------------------- settings */

app.get('/api/settings', async (req) => {
  const notify = getSettings()
  // The webhook URL lets anyone post in the channel: only full access sees it.
  return {
    notify: accessOf(req) === 'full' ? notify : { ...notify, webhook_url: '' },
    snapshot_retention_days: SNAPSHOT_RETENTION_MS / 86400000
  }
})

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
console.log(`[mossadTracker] API on ${address}`)
startScheduler()
scheduleBackfill()
startBot()
startAlertLoop()
