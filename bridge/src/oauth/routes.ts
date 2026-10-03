/**
 * The bridge is both OAuth 2.1 resource server (for /mcp) and its own tiny
 * authorization server, with exactly one resource owner: Ryan. The consent
 * page asks for the owner passphrase; a token therefore always stands for
 * `config.ownerSubject`, and every subscription records that subject plus the
 * client_id that holds the token. That is the "explicit ownership".
 */
import { Hono } from 'hono'
import type { Deps } from '../deps.js'
import { mcpResource } from '../config.js'
import { isRecord, parseJson, randomId, safeEqual } from '../util.js'
import { assertRedirectUri, ClientError, registerClient, resolveClient } from './clients.js'
import { keys, SCOPE_EVENTS, type AuthRequest } from './model.js'
import { issueCode, issueTokens, pkceMatches, redeemCode, rotateRefresh } from './tokens.js'

export const PRM_PATH = '/.well-known/oauth-protected-resource'
export const AS_METADATA_PATH = '/.well-known/oauth-authorization-server'

export function protectedResourceMetadata(deps: Deps) {
  const { publicUrl } = deps.config
  return {
    resource: mcpResource(deps.config),
    authorization_servers: [publicUrl],
    scopes_supported: [SCOPE_EVENTS],
    bearer_methods_supported: ['header'],
    resource_name: 'Lucy doorbell bridge',
  }
}

export function authorizationServerMetadata(deps: Deps) {
  const { publicUrl } = deps.config
  return {
    issuer: publicUrl,
    authorization_endpoint: `${publicUrl}/oauth/authorize`,
    token_endpoint: `${publicUrl}/oauth/token`,
    registration_endpoint: `${publicUrl}/oauth/register`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [SCOPE_EVENTS],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  }
}

export const wwwAuthenticate = (deps: Deps, extra = ''): string =>
  `Bearer resource_metadata="${deps.config.publicUrl}${PRM_PATH}/mcp", scope="${SCOPE_EVENTS}"${extra}`

const esc = (s: string): string => s.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#222}label{display:block;margin:1rem 0 .25rem}input{font:inherit;padding:.5rem;width:100%;box-sizing:border-box}button{font:inherit;padding:.6rem 1.2rem;margin-top:1rem}code{background:#eee;padding:.1rem .3rem}.err{color:#b00020}</style></head><body>${body}</body></html>`
}

function redirectWithError(redirectUri: string, state: string | undefined, issuer: string, error: string, description: string): string {
  const u = new URL(redirectUri)
  u.searchParams.set('error', error)
  u.searchParams.set('error_description', description)
  if (state !== undefined) u.searchParams.set('state', state)
  u.searchParams.set('iss', issuer)
  return u.toString()
}

export function oauthRoutes(deps: Deps): Hono {
  const app = new Hono()
  const { config } = deps
  const resource = mcpResource(config)
  const acceptedResources = new Set([resource, config.publicUrl, `${config.publicUrl}/`])

  app.get(PRM_PATH, c => c.json(protectedResourceMetadata(deps)))
  app.get(`${PRM_PATH}/mcp`, c => c.json(protectedResourceMetadata(deps)))
  app.get(AS_METADATA_PATH, c => c.json(authorizationServerMetadata(deps)))

  app.post('/oauth/register', async c => {
    const body = parseJson(await c.req.text())
    try {
      const client = await registerClient(body, deps)
      return c.json(
        {
          client_id: client.client_id,
          client_name: client.client_name,
          redirect_uris: client.redirect_uris,
          token_endpoint_auth_method: 'none',
          grant_types: client.grant_types,
          response_types: client.response_types,
          client_id_issued_at: Math.floor(deps.now().getTime() / 1000),
        },
        201,
      )
    } catch (err) {
      if (err instanceof ClientError) return c.json({ error: err.code === 'invalid_request' ? 'invalid_redirect_uri' : err.code, error_description: err.message }, 400)
      throw err
    }
  })

  app.get('/oauth/authorize', async c => {
    const q = c.req.query()
    const clientId = q.client_id ?? ''
    const redirectUri = q.redirect_uri ?? ''
    const state = q.state
    // Client and redirect_uri problems must NOT redirect (open-redirect protection).
    let clientName = clientId
    try {
      const client = await resolveClient(clientId, deps)
      assertRedirectUri(client, redirectUri, deps)
      clientName = client.client_name ?? clientId
    } catch (err) {
      if (err instanceof ClientError) return c.html(page('Authorization refused', `<h1>Authorization refused</h1><p class="err">${esc(err.code)}: ${esc(err.message)}</p>`), 400)
      throw err
    }
    const fail = (error: string, description: string) => c.redirect(redirectWithError(redirectUri, state, config.publicUrl, error, description), 302)
    if (q.response_type !== 'code') return fail('unsupported_response_type', 'response_type must be code')
    if (!q.code_challenge || q.code_challenge_method !== 'S256') return fail('invalid_request', 'PKCE S256 code_challenge is required')
    if (!/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge)) return fail('invalid_request', 'code_challenge is not a base64url SHA-256')
    const requestedResource = q.resource ?? resource
    if (!acceptedResources.has(requestedResource)) return fail('invalid_target', `resource must be ${resource}`)
    const scopes = (q.scope ?? SCOPE_EVENTS).split(/\s+/).filter(Boolean)
    if (scopes.some(s => s !== SCOPE_EVENTS)) return fail('invalid_scope', `only the ${SCOPE_EVENTS} scope exists`)

    const req: AuthRequest = {
      id: randomId('ar_'),
      clientId,
      clientName,
      redirectUri,
      codeChallenge: q.code_challenge,
      state,
      scope: SCOPE_EVENTS,
      resource,
      createdAt: deps.now().toISOString(),
    }
    await deps.store.set(keys.authreq(req.id), req, { ttlSeconds: config.authCodeTtlSeconds })
    return c.html(
      page(
        'Lucy doorbell bridge — approve',
        `<h1>Approve access to the Lucy doorbell bridge</h1>
<p><strong>${esc(clientName)}</strong> asks to subscribe to <code>lucy.ping</code> events on behalf of the bridge owner (<code>${esc(config.ownerSubject)}</code>).</p>
<p>It will be sent back to <code>${esc(new URL(redirectUri).host)}</code>.</p>
<form method="post" action="/oauth/authorize" autocomplete="off">
<input type="hidden" name="request_id" value="${esc(req.id)}">
<label for="pp">Owner passphrase</label>
<input id="pp" name="passphrase" type="password" required autofocus>
<button type="submit">Approve</button>
</form>`,
      ),
    )
  })

  app.post('/oauth/authorize', async c => {
    const form = await c.req.parseBody()
    const requestId = typeof form.request_id === 'string' ? form.request_id : ''
    const passphrase = typeof form.passphrase === 'string' ? form.passphrase : ''
    const req = requestId ? await deps.store.get<AuthRequest>(keys.authreq(requestId)) : undefined
    if (!req) return c.html(page('Expired', `<h1>This approval request has expired.</h1><p>Start the connection again from ChatGPT.</p>`), 400)
    if (!safeEqual(passphrase, config.ownerPassphrase)) {
      deps.log('oauth.consent.denied', { clientId: req.clientId })
      return c.html(page('Not approved', `<h1>Passphrase did not match.</h1><p class="err">Go back and try again, or start over from ChatGPT.</p>`), 401)
    }
    await deps.store.delete(keys.authreq(requestId))
    const code = await issueCode(
      { clientId: req.clientId, redirectUri: req.redirectUri, codeChallenge: req.codeChallenge, scope: req.scope, resource: req.resource, subject: config.ownerSubject, issuedAt: deps.now().toISOString() },
      deps,
    )
    const u = new URL(req.redirectUri)
    u.searchParams.set('code', code)
    if (req.state !== undefined) u.searchParams.set('state', req.state)
    u.searchParams.set('iss', config.publicUrl)
    deps.log('oauth.consent.approved', { clientId: req.clientId })
    return c.redirect(u.toString(), 302)
  })

  app.post('/oauth/token', async c => {
    const form = await c.req.parseBody()
    const f = (k: string): string | undefined => (typeof form[k] === 'string' ? (form[k] as string) : undefined)
    const err = (error: string, description: string, status: 400 | 401 = 400) => c.json({ error, error_description: description }, status)
    const grant = f('grant_type')
    const clientId = f('client_id') ?? ''
    if (!clientId) return err('invalid_client', 'client_id is required', 401)
    if (grant === 'authorization_code') {
      const code = f('code')
      const verifier = f('code_verifier')
      if (!code || !verifier) return err('invalid_request', 'code and code_verifier are required')
      const row = await redeemCode(code, deps)
      if (!row) return err('invalid_grant', 'code is unknown, used or expired')
      if (row.clientId !== clientId) return err('invalid_grant', 'code was issued to another client')
      if (f('redirect_uri') !== undefined && f('redirect_uri') !== row.redirectUri) return err('invalid_grant', 'redirect_uri does not match')
      if (!pkceMatches(verifier, row.codeChallenge)) return err('invalid_grant', 'PKCE verification failed')
      const requestedResource = f('resource')
      if (requestedResource !== undefined && !acceptedResources.has(requestedResource)) return err('invalid_target', `resource must be ${resource}`)
      const tokens = await issueTokens({ subject: row.subject, clientId, scope: row.scope, resource: row.resource }, deps)
      deps.log('oauth.token.issued', { clientId, grant })
      return c.json(tokens, 200, { 'cache-control': 'no-store', pragma: 'no-cache' })
    }
    if (grant === 'refresh_token') {
      const refresh = f('refresh_token')
      if (!refresh) return err('invalid_request', 'refresh_token is required')
      const tokens = await rotateRefresh(refresh, clientId, deps)
      if (!tokens) return err('invalid_grant', 'refresh_token is unknown, used or expired')
      deps.log('oauth.token.issued', { clientId, grant })
      return c.json(tokens, 200, { 'cache-control': 'no-store', pragma: 'no-cache' })
    }
    return err('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token')
  })

  return app
}

export { isRecord }
