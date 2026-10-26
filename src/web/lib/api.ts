import type {
  AuditEntry,
  BotSettings,
  Group,
  HistoryResponse,
  Me,
  Note,
  Period,
  PlayerDetail,
  PlayerRow,
  SchedulerStatus,
  SearchResult,
  TimelineSession
} from '../../shared/types.ts'
import type { StatCard } from '../../shared/stats.ts'

export interface NotifySettings {
  webhook_url: string
  enabled: boolean
  games: string[]
}

/** `/tracker/` in production: every call goes through the same prefix as the page. */
const BASE = import.meta.env.BASE_URL.replace(/\/$/, '')

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  // Only declare a JSON body when there actually is one: a DELETE that announces
  // application/json with an empty body is rejected by Fastify with a 400.
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) }
  if (init?.body !== undefined) headers['Content-Type'] = 'application/json'

  const res = await fetch(BASE + path, { ...init, headers })
  const body = (await res.json().catch(() => ({}))) as T & { error?: string; nextAt?: number }
  if (!res.ok) {
    const err = new Error(body.error ?? `http_${res.status}`) as Error & { status: number; nextAt?: number; limit?: number }
    err.status = res.status
    err.nextAt = body.nextAt
    err.limit = (body as { limit?: number }).limit
    throw err
  }
  return body
}

export const api = {
  me: () => req<Me>('/api/me'),
  players: () => req<{ players: PlayerRow[] }>('/api/players').then((r) => r.players),
  player: (uuid: string) => req<PlayerDetail>(`/api/players/${uuid}`),
  addPlayer: (identifier: string) => req<{ player: PlayerRow }>('/api/players', { method: 'POST', body: JSON.stringify({ identifier }) }),
  removePlayer: (uuid: string) => req<{ ok: boolean }>(`/api/players/${uuid}`, { method: 'DELETE' }),
  setEnabled: (uuid: string, enabled: boolean) =>
    req<{ player: PlayerRow }>(`/api/players/${uuid}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
  refresh: (uuid: string, bucket = 'all') =>
    req<{ ok: boolean; changed: number; player: PlayerRow }>(`/api/players/${uuid}/refresh`, {
      method: 'POST',
      body: JSON.stringify({ bucket })
    }),
  history: (uuid: string, period: Period) => req<HistoryResponse>(`/api/players/${uuid}/history?period=${period}`),
  stats: (uuid: string, game: string, period: Period | 'all') =>
    req<StatCard>(`/api/stats/${uuid}/${game}?period=${period}`),
  search: (q: string) => req<{ results: SearchResult[] }>(`/api/search?q=${encodeURIComponent(q)}`).then((r) => r.results),
  status: () => req<SchedulerStatus>('/api/status'),
  settings: () => req<{ notify: NotifySettings; snapshot_retention_days: number }>('/api/settings'),
  saveSettings: (body: Partial<NotifySettings>) =>
    req<{ notify: NotifySettings }>('/api/settings', { method: 'PUT', body: JSON.stringify(body) }),
  testAlert: () => req<{ ok: boolean }>('/api/settings/test', { method: 'POST' }),
  backfill: (months = 6) =>
    req<{ requests: number; rows: number; skipped: number }>('/api/backfill', {
      method: 'POST',
      body: JSON.stringify({ months })
    }),
  setNotify: (uuid: string, notify: boolean) =>
    req<{ player: PlayerRow }>(`/api/players/${uuid}`, { method: 'PATCH', body: JSON.stringify({ notify }) }),
  setTags: (uuid: string, tags: string[]) =>
    req<{ player: PlayerRow }>(`/api/players/${uuid}`, { method: 'PATCH', body: JSON.stringify({ tags }) }),
  setGroup: (uuid: string, group_id: number | null) =>
    req<{ player: PlayerRow }>(`/api/players/${uuid}`, { method: 'PATCH', body: JSON.stringify({ group_id }) }),
  addNote: (uuid: string, body: string) =>
    req<{ note: Note }>(`/api/players/${uuid}/notes`, { method: 'POST', body: JSON.stringify({ body }) }),
  deleteNote: (uuid: string, id: number) => req<{ ok: boolean }>(`/api/players/${uuid}/notes/${id}`, { method: 'DELETE' }),
  timeline: (uuid: string, days = 56) => req<{ days: number; sessions: TimelineSession[] }>(`/api/players/${uuid}/timeline?days=${days}`),
  exportUrl: (uuid: string, kind: 'sessions' | 'stats') => `${BASE}/api/players/${uuid}/export/${kind}.csv`,
  groups: () => req<{ groups: Group[] }>('/api/groups').then((r) => r.groups),
  createGroup: (g: Partial<Omit<Group, 'id'>>) => req<{ group: Group }>('/api/groups', { method: 'POST', body: JSON.stringify(g) }),
  updateGroup: (id: number, g: Partial<Omit<Group, 'id'>>) =>
    req<{ group: Group }>(`/api/groups/${id}`, { method: 'PATCH', body: JSON.stringify(g) }),
  deleteGroup: (id: number) => req<{ ok: boolean }>(`/api/groups/${id}`, { method: 'DELETE' }),
  audit: (before?: number) => req<{ entries: AuditEntry[] }>(`/api/audit?limit=200${before ? `&before=${before}` : ''}`).then((r) => r.entries),
  botSettings: () => req<{ settings: BotSettings; bot: boolean }>('/api/bot-settings'),
  saveBotSettings: (s: Partial<BotSettings>) =>
    req<{ settings: BotSettings }>('/api/bot-settings', { method: 'PUT', body: JSON.stringify(s) })
}
