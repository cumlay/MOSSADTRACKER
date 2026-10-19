/** Hive game catalogue. IDs are the ones used by the v0 API (see docs/hive-api.md §4). */

export interface GameInfo {
  id: string
  name: string
  short: string
  /** Counter fields, in display order. `played` is always the activity signal. */
  stats: string[]
  color: string
  /** Sub-modes roll up to their parent game for filtering (sky-kits -> sky). */
  parent?: string
}

/** Real games, i.e. the ones with a `played` counter we can diff for activity. */
export const GAMES: GameInfo[] = [
  { id: 'wars', name: 'TreasureWars', short: 'TW', color: '#e8b923', stats: ['played', 'victories', 'kills', 'final_kills', 'treasure_destroyed', 'deaths'] },
  { id: 'sky', name: 'SkyWars', short: 'SW', color: '#4aa3ff', stats: ['played', 'victories', 'kills', 'final_kills', 'ores_mined', 'mystery_chests_destroyed', 'spells_used', 'deaths'] },
  { id: 'bed', name: 'BedWars', short: 'BW', color: '#ff5c7a', stats: ['played', 'victories', 'kills', 'final_kills', 'beds_destroyed', 'deaths'] },
  { id: 'murder', name: 'MurderMystery', short: 'MM', color: '#b76bff', stats: ['played', 'victories', 'murders', 'murderer_eliminations', 'coins', 'deaths'] },
  { id: 'hide', name: 'HideAndSeek', short: 'HS', color: '#37d67a', stats: ['played', 'victories', 'hider_kills', 'seeker_kills', 'deaths'] },
  { id: 'dr', name: 'DeathRun', short: 'DR', color: '#ff8a3d', stats: ['played', 'victories', 'kills', 'checkpoints', 'activated', 'deaths'] },
  { id: 'sg', name: 'SurvivalGames', short: 'SG', color: '#8fd14f', stats: ['played', 'victories', 'kills', 'crates', 'deathmatches', 'deaths'] },
  { id: 'ctf', name: 'Capture The Flag', short: 'CTF', color: '#22c2c2', stats: ['played', 'victories', 'kills', 'assists', 'flags_captured', 'flags_returned', 'deaths'] },
  { id: 'build', name: 'Build Battle', short: 'BB', color: '#ffa5d8', stats: ['played', 'victories', 'rating_great_received', 'rating_love_received', 'rating_good_received'] },
  { id: 'drop', name: 'Block Drop', short: 'BD', color: '#6f7dff', stats: ['played', 'victories', 'blocks_destroyed', 'powerups_collected', 'vaults_used', 'deaths'] },
  { id: 'grav', name: 'Gravity', short: 'GR', color: '#9aa4b2', stats: ['played', 'victories', 'maps_completed', 'maps_completed_without_dying', 'deaths'] },
  { id: 'party', name: 'BlockParty', short: 'BP', color: '#ff6bd6', stats: ['played', 'victories', 'rounds_survived', 'powerups_collected'] },
  { id: 'ground', name: 'GroundWars', short: 'GW', color: '#c98c5a', stats: ['played', 'victories', 'kills', 'blocks_placed', 'blocks_destroyed', 'projectiles_fired', 'deaths'] },
  { id: 'bridge', name: 'The Bridge', short: 'TB', color: '#4fd1c5', stats: ['played', 'victories', 'goals', 'kills', 'deaths'] }
]

export const GAME_IDS = GAMES.map((g) => g.id)
const BY_ID = new Map(GAMES.map((g) => [g.id, g]))

export function game(id: string): GameInfo {
  return BY_ID.get(id) ?? { id, name: id, short: id.slice(0, 3).toUpperCase(), color: '#8b93a7', stats: ['played'] }
}

/**
 * Keys inside an `all/all` payload that are NOT diffable games.
 * `main` is the account profile, `parkour` is a nested structure with no `played`.
 */
export const NON_GAME_KEYS = new Set([
  'main',
  'parkour',
  // Retired SkyWars sub-modes. Hive still returns their blocks, and their `xp` field
  // mirrors the parent SkyWars value, so ingesting them produced activity events with
  // no matches behind them.
  'sky-classic',
  'sky-kits'
])

/** Filtering identity: a sub-mode counts as its parent game. */
export function canonicalGame(id: string): string {
  return game(id).parent ?? id
}
