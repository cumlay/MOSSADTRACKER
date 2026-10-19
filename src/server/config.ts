import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')

// Secrets (Discord token…) live in .env, which is gitignored. Absent file is fine —
// every value it holds is optional.
try {
  process.loadEnvFile(resolve(root, '.env'))
} catch {
  /* no .env, carry on with the real environment */
}

export const config = {
  // API_PORT wins over PORT: in dev, PORT belongs to the Vite server.
  port: Number(process.env.API_PORT ?? process.env.PORT ?? 3717),
  host: process.env.HOST ?? '127.0.0.1',
  dbPath: process.env.DB_PATH ?? resolve(root, 'data/tracker.db'),
  webDist: resolve(root, 'dist/web'),

  hive: {
    base: 'https://api.playhive.com',
    userAgent: 'ninjaTracker/0.1 (+player activity tracker)',
    /** Documented global cap: 120 requests / minute / IP. We stay under it. */
    globalPerMinute: 100,
    /**
     * Measured: 3 requests per (player, game) bucket per 60 min, anonymous.
     * We spend 3 per hour but never more than one every `bucketSpacingMs`,
     * which is safe under both a fixed-window and a sliding-window limiter.
     */
    bucketQuota: 3,
    bucketWindowMs: 60 * 60 * 1000,
    bucketSpacingMs: 20 * 60 * 1000,
    timeoutMs: 15_000
  },

  scheduler: {
    tickMs: 15_000,
    /** Activity newer than this promotes a player to the `hot` tier. */
    hotWindowMs: 30 * 60 * 1000,
    warmWindowMs: 24 * 60 * 60 * 1000,
    dormantAfterMs: 14 * 24 * 60 * 60 * 1000,
    /** Gap that closes a session. */
    sessionGapMs: 30 * 60 * 1000,
    /** An activity window ending less than this ago means "live". */
    liveWindowMs: 15 * 60 * 1000
  }
} as const
