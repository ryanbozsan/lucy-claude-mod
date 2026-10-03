import type { Deps } from '../deps.js'
import { b64url, randomToken, sha256 } from '../util.js'
import { keys, type AuthCode, type Principal, type TokenRow } from './model.js'

const hash = (t: string): string => b64url(sha256(t))

export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false
  return b64url(sha256(verifier)) === challenge
}

export async function issueCode(code: AuthCode, deps: Deps): Promise<string> {
  const token = randomToken('lcb_code_', 32)
  await deps.store.set(keys.code(hash(token)), code, { ttlSeconds: deps.config.authCodeTtlSeconds })
  return token
}

/** Takes the code (single use, atomically: concurrent redemptions cannot both succeed). */
export async function redeemCode(token: string, deps: Deps): Promise<AuthCode | undefined> {
  return deps.store.take<AuthCode>(keys.code(hash(token)))
}

export type IssuedTokens = { access_token: string; token_type: 'Bearer'; expires_in: number; refresh_token: string; scope: string }

export async function issueTokens(p: Principal, deps: Deps, family?: string): Promise<IssuedTokens> {
  const now = deps.now()
  const { accessTokenTtlSeconds, refreshTokenTtlSeconds } = deps.config
  const access = randomToken('lcb_at_', 32)
  const refresh = randomToken('lcb_rt_', 32)
  const fam = family ?? randomToken('fam_', 12)
  const base = { subject: p.subject, clientId: p.clientId, scope: p.scope, resource: p.resource, issuedAt: now.toISOString() }
  await deps.store.set(
    keys.token(hash(access)),
    { ...base, kind: 'access', expiresAt: new Date(now.getTime() + accessTokenTtlSeconds * 1000).toISOString() } satisfies TokenRow,
    { ttlSeconds: accessTokenTtlSeconds },
  )
  await deps.store.set(
    keys.token(hash(refresh)),
    { ...base, kind: 'refresh', family: fam, expiresAt: new Date(now.getTime() + refreshTokenTtlSeconds * 1000).toISOString() } satisfies TokenRow,
    { ttlSeconds: refreshTokenTtlSeconds },
  )
  return { access_token: access, token_type: 'Bearer', expires_in: accessTokenTtlSeconds, refresh_token: refresh, scope: p.scope }
}

export async function readToken(token: string, kind: TokenRow['kind'], deps: Deps): Promise<TokenRow | undefined> {
  const row = await deps.store.get<TokenRow>(keys.token(hash(token)))
  if (!row || row.kind !== kind) return undefined
  if (new Date(row.expiresAt).getTime() <= deps.now().getTime()) return undefined
  return row
}

export async function revokeToken(token: string, deps: Deps): Promise<void> {
  await deps.store.delete(keys.token(hash(token)))
}

/**
 * Rotates a refresh token: the old one is spent atomically (so two concurrent
 * refreshes cannot both succeed), and a new pair is issued in the same family.
 */
export async function rotateRefresh(refresh: string, clientId: string, deps: Deps): Promise<IssuedTokens | undefined> {
  const row = await deps.store.take<TokenRow>(keys.token(hash(refresh)))
  if (!row || row.kind !== 'refresh') return undefined
  if (new Date(row.expiresAt).getTime() <= deps.now().getTime()) return undefined
  if (row.clientId !== clientId) return undefined
  return issueTokens({ subject: row.subject, clientId: row.clientId, scope: row.scope, resource: row.resource }, deps, row.family)
}

/** Resource-server check: a bearer access token for this resource. */
export async function authenticateBearer(authorization: string | undefined, resource: string, deps: Deps): Promise<Principal | undefined> {
  const m = /^Bearer\s+(\S+)$/i.exec(authorization ?? '')
  if (!m) return undefined
  const row = await readToken(m[1]!, 'access', deps)
  if (!row) return undefined
  if (row.resource !== resource) return undefined
  return { subject: row.subject, clientId: row.clientId, scope: row.scope, resource: row.resource }
}
