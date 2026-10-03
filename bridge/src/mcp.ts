/**
 * The MCP endpoint (protocol revision 2026-07-28, Streamable HTTP, stateless)
 * with the MCP Events methods ChatGPT calls: events/list, events/subscribe,
 * events/unsubscribe. server/discover advertises `events: {}`.
 */
import { Hono } from 'hono'
import { assertPublicHttpsUrl, CallbackError, verifyCallback } from './callback.js'
import { mcpResource } from './config.js'
import type { Deps } from './deps.js'
import { EVENT_DEFINITIONS, LUCY_PING, SUB_PREFIX, subKey, type Subscription } from './events.js'
import { authenticateBearer } from './oauth/tokens.js'
import { wwwAuthenticate } from './oauth/routes.js'
import type { Principal } from './oauth/model.js'
import { decodeSecret } from './webhooks.js'
import { isRecord, parseJson, randomId } from './util.js'

export const PROTOCOL_VERSION = '2026-07-28'
export const SERVER_INFO = { name: 'lucy-bridge', version: '0.1.0' }

const META_VERSION = 'io.modelcontextprotocol/protocolVersion'
const META_CAPS = 'io.modelcontextprotocol/clientCapabilities'
const META_SERVER = 'io.modelcontextprotocol/serverInfo'

type Id = string | number
const rpcError = (id: Id | null, code: number, message: string, data?: unknown) => ({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } })
const rpcResult = (id: Id, result: Record<string, unknown>) => ({ jsonrpc: '2.0', id, result: { resultType: 'complete', ...result, _meta: { [META_SERVER]: SERVER_INFO } } })

export class RpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown, readonly http: number = 200) {
    super(message)
  }
}

const sameIdentity = (s: Subscription, owner: string, name: string, args: Record<string, unknown>, url: string): boolean =>
  s.owner === owner && s.name === name && s.url === url && JSON.stringify(s.arguments) === JSON.stringify(args)

export async function activeSubscriptions(deps: Deps, owner: string, name: string): Promise<Subscription[]> {
  const now = deps.now().getTime()
  const rows = await deps.store.list<Subscription>(SUB_PREFIX)
  return rows.map(r => r.value).filter(s => s.owner === owner && s.name === name && !s.deadAt && new Date(s.refreshBefore).getTime() > now)
}

async function handleSubscribe(params: unknown, who: Principal, deps: Deps): Promise<Record<string, unknown>> {
  if (!isRecord(params)) throw new RpcError(-32602, 'params must be an object')
  const { name, delivery } = params
  if (name !== LUCY_PING) throw new RpcError(-32602, `unknown event ${String(name)}; events/list names the ones that exist`)
  const args = params.arguments === undefined ? {} : params.arguments
  if (!isRecord(args) || Object.keys(args).length > 0) throw new RpcError(-32602, `${LUCY_PING} takes no arguments`)
  if (!isRecord(delivery) || delivery.mode !== 'webhook') throw new RpcError(-32602, 'delivery.mode must be webhook')
  const url = delivery.url
  const secret = delivery.secret
  if (typeof url !== 'string') throw new RpcError(-32602, 'delivery.url is required')
  if (typeof secret !== 'string') throw new RpcError(-32602, 'delivery.secret is required')
  try {
    decodeSecret(secret)
  } catch (err) {
    throw new RpcError(-32602, (err as Error).message)
  }
  if (params.cursor !== undefined && params.cursor !== null) throw new RpcError(-32602, 'cursors are not supported; send null')
  const ttl = params.ttlMs
  if (ttl !== undefined && ttl !== null && (typeof ttl !== 'number' || !(ttl > 0))) throw new RpcError(-32602, 'ttlMs must be a positive number or null')

  // The subscription identity is (owner, event, arguments, callback url). A
  // refresh keeps the id; a new subscription gets its id now, before
  // verification, because the verification request carries it.
  const existing = (await deps.store.list<Subscription>(SUB_PREFIX)).map(r => r.value).find(s => sameIdentity(s, who.subject, LUCY_PING, {}, url))
  const id = existing?.id ?? randomId('sub_')

  try {
    await assertPublicHttpsUrl(url, deps)
    await verifyCallback(url, secret, id, deps)
  } catch (err) {
    if (err instanceof CallbackError) throw new RpcError(-32015, `CallbackEndpointError: ${err.message}`, { reason: err.reason })
    throw err
  }

  const now = deps.now()
  const { subscriptionTtlMs, maxSubscriptionTtlMs } = deps.config
  const grantMs = Math.min(typeof ttl === 'number' ? ttl : subscriptionTtlMs, maxSubscriptionTtlMs)
  const refreshBefore = new Date(now.getTime() + grantMs).toISOString()

  const sub: Subscription = existing
    ? { ...existing, secret, clientId: who.clientId, refreshedAt: now.toISOString(), refreshBefore, deadAt: undefined }
    : {
        id,
        owner: who.subject,
        clientId: who.clientId,
        name: LUCY_PING,
        arguments: {},
        url,
        secret,
        createdAt: now.toISOString(),
        refreshedAt: now.toISOString(),
        refreshBefore,
        cursor: null,
      }
  await deps.store.set(subKey(sub.id), sub)
  deps.log(existing ? 'events.subscribe.refreshed' : 'events.subscribe.created', { id: sub.id, owner: sub.owner, clientId: sub.clientId, host: new URL(sub.url).host })
  return { id: sub.id, refreshBefore, cursor: null, truncated: false }
}

async function handleUnsubscribe(params: unknown, who: Principal, deps: Deps): Promise<Record<string, unknown>> {
  if (!isRecord(params)) throw new RpcError(-32602, 'params must be an object')
  const { name, delivery } = params
  const args = params.arguments === undefined ? {} : params.arguments
  if (!isRecord(args)) throw new RpcError(-32602, 'arguments must be an object')
  if (!isRecord(delivery) || typeof delivery.url !== 'string') throw new RpcError(-32602, 'delivery.url is required')
  const rows = await deps.store.list<Subscription>(SUB_PREFIX)
  for (const { key, value } of rows) {
    if (sameIdentity(value, who.subject, String(name), args, delivery.url)) {
      await deps.store.delete(key)
      deps.log('events.unsubscribe', { id: value.id, owner: value.owner })
    }
  }
  return {}
}

export function mcpRoutes(deps: Deps): Hono {
  const app = new Hono()
  const resource = mcpResource(deps.config)
  const origin = new URL(deps.config.publicUrl).origin

  app.on(['GET', 'DELETE', 'PUT', 'PATCH'], '/mcp', c => c.json(rpcError(null, -32601, 'Use POST for the MCP endpoint'), 405))

  app.post('/mcp', async c => {
    // DNS-rebinding guard: a browser-originated request must come from our own origin.
    const reqOrigin = c.req.header('origin')
    if (reqOrigin && reqOrigin !== origin) return c.json(rpcError(null, -32600, 'Origin not allowed'), 403)

    const who = await authenticateBearer(c.req.header('authorization'), resource, deps)
    if (!who) {
      c.header('WWW-Authenticate', wwwAuthenticate(deps))
      return c.json({ error: 'unauthorized', error_description: 'a bearer token for this resource is required' }, 401)
    }

    const body = parseJson(await c.req.text())
    if (!isRecord(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
      return c.json(rpcError(null, -32600, 'Invalid Request: expected one JSON-RPC 2.0 request'), 400)
    }
    const id = body.id as Id | undefined
    const method = body.method
    const params = body.params
    const meta = isRecord(params) && isRecord(params._meta) ? params._meta : undefined

    if (id === undefined || id === null) return c.body(null, 202) // notification: accepted, nothing to say

    const headerVersion = c.req.header('mcp-protocol-version')
    const bodyVersion = meta?.[META_VERSION]
    if (method === 'initialize') {
      return c.json(rpcError(id, -32601, `This server speaks MCP ${PROTOCOL_VERSION} (per-request _meta); initialize is not supported`, { supported: [PROTOCOL_VERSION] }), 404)
    }
    if (!headerVersion) return c.json(rpcError(id, -32020, 'MCP-Protocol-Version header is required'), 400)
    if (typeof bodyVersion !== 'string' || !isRecord(meta?.[META_CAPS])) {
      return c.json(rpcError(id, -32602, `params._meta must carry ${META_VERSION} and ${META_CAPS}`), 400)
    }
    if (headerVersion !== bodyVersion) return c.json(rpcError(id, -32020, `Header mismatch: MCP-Protocol-Version '${headerVersion}' does not match body '${bodyVersion}'`), 400)
    if (bodyVersion !== PROTOCOL_VERSION) return c.json(rpcError(id, -32022, 'Unsupported protocol version', { supported: [PROTOCOL_VERSION], requested: bodyVersion }), 400)
    const mcpMethod = c.req.header('mcp-method')
    if (mcpMethod !== undefined && mcpMethod !== method) return c.json(rpcError(id, -32020, `Header mismatch: Mcp-Method '${mcpMethod}' does not match body '${method}'`), 400)
    if (mcpMethod === undefined && deps.config.strictMcpHeaders) return c.json(rpcError(id, -32020, 'Mcp-Method header is required'), 400)

    try {
      switch (method) {
        case 'server/discover':
          return c.json(
            rpcResult(id, {
              supportedVersions: [PROTOCOL_VERSION],
              capabilities: { tools: {}, events: {} },
              instructions: `This bridge emits one event, ${LUCY_PING}, when Claude manually rings Lucy's doorbell. When it arrives, acknowledge it in the chat by repeating the eventId.`,
            }),
          )
        case 'tools/list':
          return c.json(rpcResult(id, { tools: [] }))
        case 'events/list':
          return c.json(rpcResult(id, { events: EVENT_DEFINITIONS }))
        case 'events/subscribe':
          return c.json(rpcResult(id, await handleSubscribe(params, who, deps)))
        case 'events/unsubscribe':
          return c.json(rpcResult(id, await handleUnsubscribe(params, who, deps)))
        default:
          return c.json(rpcError(id, -32601, `Method not found: ${method}`), 404)
      }
    } catch (err) {
      if (err instanceof RpcError) return c.json(rpcError(id, err.code, err.message, err.data), err.code === -32602 ? 400 : 200)
      deps.log('mcp.error', { method, message: (err as Error)?.message })
      return c.json(rpcError(id, -32603, 'Internal error'), 500)
    }
  })

  return app
}
