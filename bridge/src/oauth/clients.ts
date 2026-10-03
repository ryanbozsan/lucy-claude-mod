/**
 * Client identity for the OAuth flow.
 *
 * Preferred: Client ID Metadata Documents (CIMD), which is how ChatGPT presents
 * itself (`https://chatgpt.com/oauth/client.json` or the per-callback variant).
 * The client_id IS an https URL; we fetch it, require `client_id` in the document
 * to equal the URL exactly, and only honour redirect URIs the document lists.
 *
 * Fallback: Dynamic Client Registration (RFC 7591), kept because ChatGPT lists it
 * as a supported option. Registration is only accepted for redirect hosts in the
 * allow-list, so a stranger cannot register a client that redirects to them.
 */
import type { Deps } from '../deps.js'
import { isRecord, parseJson, randomId } from '../util.js'
import { keys, type RegisteredClient } from './model.js'

export class ClientError extends Error {
  constructor(readonly code: 'invalid_client' | 'invalid_request' | 'unauthorized_client', message: string) {
    super(message)
  }
}

const MAX_DOC_BYTES = 64 * 1024

export function isCimdClientId(clientId: string): boolean {
  try {
    const u = new URL(clientId)
    return u.protocol === 'https:' && u.pathname.length > 1 && !u.hash
  } catch {
    return false
  }
}

function hostAllowed(uri: string, allowed: string[]): boolean {
  try {
    const u = new URL(uri)
    return u.protocol === 'https:' && allowed.includes(u.hostname)
  } catch {
    return false
  }
}

async function fetchCimd(clientId: string, deps: Deps): Promise<RegisteredClient> {
  const cached = await deps.store.get<RegisteredClient>(keys.cimd(clientId))
  if (cached) return cached
  let res: Response
  try {
    res = await deps.fetch(clientId, { method: 'GET', headers: { accept: 'application/json' }, redirect: 'error' })
  } catch (err) {
    throw new ClientError('invalid_client', `could not fetch client metadata: ${(err as Error)?.message ?? err}`)
  }
  if (!res.ok) throw new ClientError('invalid_client', `client metadata answered HTTP ${res.status}`)
  const text = await res.text()
  if (text.length > MAX_DOC_BYTES) throw new ClientError('invalid_client', 'client metadata document too large')
  const doc = parseJson(text)
  if (!isRecord(doc)) throw new ClientError('invalid_client', 'client metadata is not a JSON object')
  if (doc.client_id !== clientId) throw new ClientError('invalid_client', 'client metadata client_id does not match its URL')
  if (!Array.isArray(doc.redirect_uris) || doc.redirect_uris.some(u => typeof u !== 'string')) {
    throw new ClientError('invalid_client', 'client metadata lacks redirect_uris')
  }
  // ChatGPT's document lists `token_endpoint_auth_methods_supported` (a set, no
  // preference) and, during a transition, the legacy singular
  // `token_endpoint_auth_method` as a preference. The client picks from the
  // intersection with what this authorization server advertises. We support
  // only `none` (PKCE), so the document must include it somewhere.
  const methods = Array.isArray(doc.token_endpoint_auth_methods_supported)
    ? (doc.token_endpoint_auth_methods_supported as unknown[]).filter((m): m is string => typeof m === 'string')
    : typeof doc.token_endpoint_auth_method === 'string'
      ? [doc.token_endpoint_auth_method]
      : ['none']
  if (!methods.includes('none')) {
    throw new ClientError('invalid_client', `client supports token endpoint auth [${methods.join(', ')}]; this server supports only none`)
  }
  const client: RegisteredClient = {
    client_id: clientId,
    client_name: typeof doc.client_name === 'string' ? doc.client_name : undefined,
    redirect_uris: doc.redirect_uris as string[],
    token_endpoint_auth_method: 'none',
    grant_types: Array.isArray(doc.grant_types) ? (doc.grant_types as string[]) : ['authorization_code'],
    response_types: Array.isArray(doc.response_types) ? (doc.response_types as string[]) : ['code'],
    source: 'cimd',
  }
  await deps.store.set(keys.cimd(clientId), client, { ttlSeconds: 60 * 60 })
  return client
}

/** Resolves a client_id to its registration, enforcing the allow-lists. */
export async function resolveClient(clientId: string, deps: Deps): Promise<RegisteredClient> {
  const { allowedClientIdPatterns, allowedRedirectHosts } = deps.config
  if (isCimdClientId(clientId)) {
    if (!allowedClientIdPatterns.some(re => re.test(clientId))) {
      throw new ClientError('unauthorized_client', 'this client_id is not on the bridge allow-list')
    }
    return fetchCimd(clientId, deps)
  }
  const dcr = await deps.store.get<RegisteredClient>(keys.client(clientId))
  if (!dcr) throw new ClientError('invalid_client', 'unknown client_id')
  if (!dcr.redirect_uris.every(u => hostAllowed(u, allowedRedirectHosts))) {
    throw new ClientError('unauthorized_client', 'client redirect hosts are no longer allowed')
  }
  return dcr
}

export function assertRedirectUri(client: RegisteredClient, redirectUri: string, deps: Deps): void {
  if (!client.redirect_uris.includes(redirectUri)) throw new ClientError('invalid_request', 'redirect_uri is not registered for this client')
  if (!hostAllowed(redirectUri, deps.config.allowedRedirectHosts)) throw new ClientError('unauthorized_client', 'redirect_uri host is not allowed')
}

/** RFC 7591 registration, restricted to public clients redirecting to allowed hosts. */
export async function registerClient(body: unknown, deps: Deps): Promise<RegisteredClient> {
  if (!isRecord(body)) throw new ClientError('invalid_request', 'registration body must be a JSON object')
  const redirectUris = body.redirect_uris
  if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.some(u => typeof u !== 'string')) {
    throw new ClientError('invalid_request', 'redirect_uris is required')
  }
  if (!redirectUris.every(u => hostAllowed(u as string, deps.config.allowedRedirectHosts))) {
    throw new ClientError('invalid_request', `redirect_uris must be https on an allowed host (${deps.config.allowedRedirectHosts.join(', ')})`)
  }
  const authMethod = (body.token_endpoint_auth_method as string | undefined) ?? 'none'
  if (authMethod !== 'none') throw new ClientError('invalid_request', 'only token_endpoint_auth_method "none" is supported')
  const client: RegisteredClient = {
    client_id: randomId('lcb_client_'),
    client_name: typeof body.client_name === 'string' ? body.client_name.slice(0, 120) : undefined,
    redirect_uris: redirectUris as string[],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    source: 'dcr',
  }
  await deps.store.set(keys.client(client.client_id), client)
  return client
}
