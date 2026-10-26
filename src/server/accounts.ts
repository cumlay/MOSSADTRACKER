/**
 * Website accounts, as seen from the Discord bot.
 *
 * The corlay account service (server/server.js) owns accounts and their permissions;
 * a Discord user who linked their account gets that account's tracker access in
 * Discord too. The service answers these calls on its loopback-only internal routes.
 */

const AUTH_URL = process.env.AUTH_URL ?? 'http://127.0.0.1:8152'
const TTL_MS = 60_000
const TIMEOUT_MS = 1_500

export type LinkedAccess = 'full' | 'user' | 'none'

export interface LinkedAccount {
  username: string
  access: LinkedAccess
}

/** discord id -> lookup, so a burst of commands does not hit the service each time. */
const cache = new Map<string, { at: number; account: LinkedAccount | null }>()

async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T | null }> {
  const res = await fetch(AUTH_URL + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  const data = (await res.json().catch(() => null)) as T | null
  return { status: res.status, data }
}

/**
 * The account linked to this Discord user, null when none is, and undefined when the
 * account service could not be reached (the caller then falls back to Discord roles).
 */
export async function linkedAccount(discordId: string): Promise<LinkedAccount | null | undefined> {
  const hit = cache.get(discordId)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.account
  try {
    const { status, data } = await call<{ linked: boolean; username?: string; access?: LinkedAccess }>(
      'GET',
      `/api/internal/discord/${encodeURIComponent(discordId)}`
    )
    if (status !== 200 || !data) return undefined
    const account = data.linked && data.username ? { username: data.username, access: data.access ?? 'none' } : null
    cache.set(discordId, { at: Date.now(), account })
    return account
  } catch {
    return undefined
  }
}

export type RedeemResult = { ok: true; account: LinkedAccount } | { ok: false; error: string }

/** Links this Discord user to the account that generated `code` on the website. */
export async function redeemLinkCode(code: string, discordId: string, discordTag: string): Promise<RedeemResult> {
  try {
    const { status, data } = await call<{ username?: string; access?: LinkedAccess; error?: string }>('POST', '/api/internal/discord/redeem', {
      code,
      discordId,
      discordTag
    })
    cache.delete(discordId)
    if (status === 200 && data?.username) return { ok: true, account: { username: data.username, access: data.access ?? 'none' } }
    return { ok: false, error: data?.error ?? 'The account service refused the code.' }
  } catch {
    return { ok: false, error: 'The account service is unreachable right now.' }
  }
}

export async function unlinkDiscord(discordId: string): Promise<boolean> {
  try {
    const { status } = await call('DELETE', `/api/internal/discord/${encodeURIComponent(discordId)}`)
    cache.delete(discordId)
    return status === 200
  } catch {
    return false
  }
}
