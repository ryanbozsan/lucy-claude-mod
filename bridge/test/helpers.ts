import { createHash } from 'node:crypto'
import type { Hono } from 'hono'
import { createApp } from '../src/app.js'
import { CHATGPT_CLIENT_ID_PATTERNS, DEFAULTS, type Config } from '../src/config.js'
import type { Deps, FetchLike } from '../src/deps.js'
import { MemoryStore } from '../src/store.js'

export const PUBLIC_URL = 'https://bridge.example.test'
export const PING_TOKEN = 'ping-token-for-tests'
export const PASSPHRASE = 'correct horse battery staple'
export const CLIENT_ID = 'https://chatgpt.com/oauth/client.json'
export const REDIRECT_URI = 'https://chatgpt.com/connector_platform_oauth_redirect'
export const CALLBACK_URL = 'https://receiver.example.test/mcp-events/callback_123'
/** whsec_ + base64 of 32 bytes */
export const SECRET = 'whsec_' + Buffer.alloc(32, 7).toString('base64')

export function testConfig(over: Partial<Config> = {}): Config {
  return {
    publicUrl: PUBLIC_URL,
    pingToken: PING_TOKEN,
    ownerPassphrase: PASSPHRASE,
    ownerSubject: 'ryan',
    allowedClientIdPatterns: CHATGPT_CLIENT_ID_PATTERNS,
    allowedRedirectHosts: ['chatgpt.com'],
    allowedCallbackHosts: [],
    subscriptionTtlMs: DEFAULTS.subscriptionTtlMs,
    maxSubscriptionTtlMs: DEFAULTS.maxSubscriptionTtlMs,
    accessTokenTtlSeconds: 3600,
    refreshTokenTtlSeconds: 86400,
    authCodeTtlSeconds: 600,
    verificationTimeoutMs: 1000,
    deliveryTimeoutMs: 1000,
    deliveryAttempts: 3,
    strictMcpHeaders: false,
    ...over,
  }
}

export type Outbound = { url: string; init: RequestInit; headers: Record<string, string>; body: string }

/**
 * A fake internet: ChatGPT's client metadata document and a webhook receiver
 * that echoes verification challenges and records deliveries. `script` lets a
 * test decide what the receiver answers per delivery.
 */
export class World {
  readonly outbound: Outbound[] = []
  readonly deliveries: Outbound[] = []
  receiverStatuses: number[] = []
  nowMs = Date.UTC(2026, 9, 3, 12, 0, 0)
  readonly store = new MemoryStore(() => this.nowMs)
  readonly logs: Array<{ line: string; fields?: Record<string, unknown> }> = []
  readonly deps: Deps
  readonly app: Hono

  constructor(config: Config = testConfig()) {
    const fetchImpl: FetchLike = async (url, init = {}) => {
      const headers = Object.fromEntries(new Headers(init.headers as HeadersInit | undefined).entries())
      const body = typeof init.body === 'string' ? init.body : ''
      const call: Outbound = { url, init, headers, body }
      this.outbound.push(call)
      if (url === CLIENT_ID) {
        return new Response(JSON.stringify({ client_id: CLIENT_ID, client_name: 'ChatGPT', redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'none' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url === CALLBACK_URL) {
        const parsed = JSON.parse(body) as { type?: string; challenge?: string }
        if (parsed.type === 'verification') return Response.json({ challenge: parsed.challenge })
        this.deliveries.push(call)
        const status = this.receiverStatuses.shift() ?? 200
        return new Response(status === 200 ? '{}' : 'nope', { status })
      }
      return new Response('not found', { status: 404 })
    }
    this.deps = {
      config,
      store: this.store,
      fetch: fetchImpl,
      now: () => new Date(this.nowMs),
      sleep: async ms => {
        this.nowMs += ms
      },
      resolve: async host => (host === 'private.example.test' ? ['10.0.0.5'] : host.endsWith('.example.test') || host === 'chatgpt.com' ? ['93.184.216.34'] : []),
      log: (line, fields) => this.logs.push({ line, fields }),
    }
    this.app = createApp(this.deps)
  }

  /** Walks the OAuth flow as ChatGPT would and returns an access token. */
  async obtainToken(opts: { clientId?: string; passphrase?: string } = {}): Promise<{ access: string; refresh: string }> {
    const clientId = opts.clientId ?? CLIENT_ID
    const verifier = 'v'.repeat(43)
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'xyz',
      scope: 'events',
      resource: `${PUBLIC_URL}/mcp`,
    })
    const consent = await this.app.request(`/oauth/authorize?${q}`)
    if (consent.status !== 200) throw new Error(`authorize page: ${consent.status} ${await consent.text()}`)
    const html = await consent.text()
    const requestId = /name="request_id" value="([^"]+)"/.exec(html)?.[1]
    if (!requestId) throw new Error('no request_id in consent page')
    const approved = await this.app.request('/oauth/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ request_id: requestId, passphrase: opts.passphrase ?? PASSPHRASE }).toString(),
    })
    if (approved.status !== 302) throw new Error(`consent: ${approved.status} ${await approved.text()}`)
    const loc = new URL(approved.headers.get('location')!)
    if (loc.origin + loc.pathname !== REDIRECT_URI) throw new Error(`redirected elsewhere: ${loc}`)
    if (loc.searchParams.get('state') !== 'xyz') throw new Error('state missing')
    if (loc.searchParams.get('iss') !== PUBLIC_URL) throw new Error('iss missing')
    const code = loc.searchParams.get('code')!
    const tok = await this.app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT_URI, resource: `${PUBLIC_URL}/mcp` }).toString(),
    })
    if (tok.status !== 200) throw new Error(`token: ${tok.status} ${await tok.text()}`)
    const json = (await tok.json()) as { access_token: string; refresh_token: string }
    return { access: json.access_token, refresh: json.refresh_token }
  }

  rpc(token: string, method: string, params: Record<string, unknown> = {}, id: string | number = 1, headerOverrides: Record<string, string | null> = {}) {
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': method,
    }
    for (const [k, v] of Object.entries(headerOverrides)) {
      if (v === null) delete headers[k]
      else headers[k] = v
    }
    const body = {
      jsonrpc: '2.0',
      id,
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': headerOverrides['x-body-version'] ?? '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 'ChatGPT', version: '1' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }
    delete headers['x-body-version']
    return this.app.request('/mcp', { method: 'POST', headers, body: JSON.stringify(body) })
  }

  async subscribe(token: string, url = CALLBACK_URL, secret = SECRET, extra: Record<string, unknown> = {}) {
    return this.rpc(token, 'events/subscribe', { name: 'lucy.ping', arguments: {}, delivery: { mode: 'webhook', url, secret }, cursor: null, ...extra }, 2)
  }

  ping(eventId: string, timestamp = '2026-10-03T12:00:00.000Z', token = PING_TOKEN) {
    return this.app.request('/ping', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ eventId, timestamp, greeting: 'Hello Lucy — this is Claude ringing your doorbell.' }),
    })
  }
}
