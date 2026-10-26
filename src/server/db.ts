import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
// node-sqlite3-wasm ships CommonJS; named ESM exports are not detected, so destructure the default.
import sqlite3wasm from 'node-sqlite3-wasm'
import { config } from './config.ts'

mkdirSync(dirname(config.dbPath), { recursive: true })

const { Database } = sqlite3wasm

export const db = new Database(config.dbPath)

db.run('PRAGMA journal_mode = WAL')
db.run('PRAGMA foreign_keys = ON')

db.exec(`
CREATE TABLE IF NOT EXISTS players (
  uuid                TEXT PRIMARY KEY,
  username            TEXT NOT NULL,
  username_cc         TEXT,
  rank                TEXT,
  enabled             INTEGER NOT NULL DEFAULT 1,
  added_at            INTEGER NOT NULL,
  tier                TEXT NOT NULL DEFAULT 'cold',
  last_seen_at        INTEGER,
  last_seen_window_ms INTEGER,
  last_game           TEXT,
  last_fetch_at       INTEGER,
  first_played        INTEGER,
  player_number       INTEGER,
  profile             TEXT
);

CREATE TABLE IF NOT EXISTS snapshots (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid       TEXT NOT NULL,
  bucket     TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  payload    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_player ON snapshots (uuid, fetched_at DESC);

-- One row per (player, game) observation, written only when a counter moved
-- (plus a baseline row on the first ever fetch).
CREATE TABLE IF NOT EXISTS stat_points (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid        TEXT NOT NULL,
  game        TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  played      INTEGER NOT NULL DEFAULT 0,
  victories   INTEGER NOT NULL DEFAULT 0,
  xp          INTEGER NOT NULL DEFAULT 0,
  kills       INTEGER NOT NULL DEFAULT 0,
  deaths      INTEGER NOT NULL DEFAULT 0,
  extra       TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_stat_points ON stat_points (uuid, game, observed_at DESC);

-- Current known values per (player, game) plus the time of the last *observation*
-- (even when nothing changed) — that timestamp is what bounds the next activity window.
CREATE TABLE IF NOT EXISTS game_state (
  uuid             TEXT NOT NULL,
  game             TEXT NOT NULL,
  last_observed_at INTEGER NOT NULL,
  last_changed_at  INTEGER,
  played           INTEGER NOT NULL DEFAULT 0,
  victories        INTEGER NOT NULL DEFAULT 0,
  xp               INTEGER NOT NULL DEFAULT 0,
  kills            INTEGER NOT NULL DEFAULT 0,
  deaths           INTEGER NOT NULL DEFAULT 0,
  extra            TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (uuid, game)
);

-- "This player finished N matches of <game> between window_start and window_end."
CREATE TABLE IF NOT EXISTS activity_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid         TEXT NOT NULL,
  game         TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  window_end   INTEGER NOT NULL,
  matches      INTEGER NOT NULL DEFAULT 0,
  delta        TEXT NOT NULL DEFAULT '{}',
  session_id   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_events_player ON activity_events (uuid, window_end DESC);

-- Players seen in the same Hive lobby as the in-game client.
-- Unlike an activity event, a sighting has no uncertainty: it is a direct observation
-- at a known instant, on a known server.
CREATE TABLE IF NOT EXISTS sightings (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid      TEXT NOT NULL,
  seen_at   INTEGER NOT NULL,
  server    TEXT,
  game      TEXT,
  mode      TEXT,
  reporter  TEXT
);
CREATE INDEX IF NOT EXISTS idx_sightings_player ON sightings (uuid, seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_sightings_time ON sightings (seen_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid       TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER NOT NULL,
  matches    INTEGER NOT NULL DEFAULT 0,
  games      TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_sessions_player ON sessions (uuid, ended_at DESC);

-- Every HTTP request we make. Powers the rate-limit ledger, so it must be written
-- before we know the outcome is fine (we log after the response, but the scheduler
-- also reserves the slot in memory).
CREATE TABLE IF NOT EXISTS fetch_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid         TEXT,
  bucket       TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  status       INTEGER NOT NULL,
  duration_ms  INTEGER NOT NULL DEFAULT 0,
  retry_after  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_fetch_bucket ON fetch_log (bucket, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_fetch_time ON fetch_log (requested_at DESC);

-- One row per (player, game, month), harvested from the monthly leaderboards.
-- Absence means "not in the top 100 that month", never "did not play".
CREATE TABLE IF NOT EXISTS monthly_stats (
  uuid       TEXT NOT NULL,
  game       TEXT NOT NULL,
  year       INTEGER NOT NULL,
  month      INTEGER NOT NULL,
  rank       INTEGER,
  stats      TEXT NOT NULL DEFAULT '{}',
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (uuid, game, year, month)
);
CREATE INDEX IF NOT EXISTS idx_monthly_player ON monthly_stats (uuid, year DESC, month DESC);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta_cache (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);

-- Free-text notes staff keep on a player ("main account of X", "check again Friday").
CREATE TABLE IF NOT EXISTS player_notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid       TEXT NOT NULL,
  author     TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_player ON player_notes (uuid, created_at DESC);

-- Groups (clans, friend groups…): a player belongs to at most one. A group can send its
-- alerts to its own Discord channel.
CREATE TABLE IF NOT EXISTS player_groups (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  color      TEXT NOT NULL,
  channel_id TEXT
);

-- Who changed the watchlist, from where. Kept forever; it is tiny.
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL,
  actor       TEXT NOT NULL,
  source      TEXT NOT NULL,
  action      TEXT NOT NULL,
  target_uuid TEXT,
  target_name TEXT,
  detail      TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log (at DESC);
`)

/**
 * Tiny forward-only migrations: the schema above uses CREATE TABLE IF NOT EXISTS, which
 * never touches a table that already exists, so new columns are added here instead.
 */
function addColumn(table: string, column: string, definition: string): boolean {
  const existing = db.all(`PRAGMA table_info(${table})`) as Array<{ name: string }>
  if (existing.some((c) => c.name === column)) return false
  db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  return true
}

addColumn('players', 'notify', 'INTEGER NOT NULL DEFAULT 1')
addColumn('players', 'tags', "TEXT NOT NULL DEFAULT '[]'")
addColumn('players', 'group_id', 'INTEGER')
/** Account that added the player — what the per-account add limit counts. */
addColumn('players', 'added_by', 'TEXT')
addColumn('game_state', 'win_streak', 'INTEGER NOT NULL DEFAULT 0')
addColumn('game_state', 'best_streak', 'INTEGER NOT NULL DEFAULT 0')

// Sessions and players that predate these flags count as already announced, or the
// first sweep after an upgrade would post a summary for every session ever recorded.
if (addColumn('sessions', 'summary_sent', 'INTEGER NOT NULL DEFAULT 0')) {
  db.run('UPDATE sessions SET summary_sent = 1')
}
if (addColumn('players', 'inactive_notified', 'INTEGER NOT NULL DEFAULT 0')) {
  db.run('UPDATE players SET inactive_notified = 1 WHERE COALESCE(last_seen_at, added_at) < ?', [Date.now() - 7 * 86_400_000])
}

type Row = Record<string, unknown>

export function all<T = Row>(sql: string, params: unknown[] = []): T[] {
  return db.all(sql, params as never) as T[]
}

export function get<T = Row>(sql: string, params: unknown[] = []): T | undefined {
  return db.get(sql, params as never) as T | undefined
}

export function run(sql: string, params: unknown[] = []): void {
  db.run(sql, params as never)
}

export function lastInsertId(): number {
  const row = get<{ id: number }>('SELECT last_insert_rowid() AS id')
  return row?.id ?? 0
}

/** node-sqlite3-wasm only binds number | string | null | bigint | Uint8Array. */
export function j(value: unknown): string {
  return JSON.stringify(value ?? null)
}

export function unj<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}
