import { describe, expect, it } from 'vitest'
import { CALLBACK_URL, SECRET, World } from './helpers.js'
import { verify } from '../src/webhooks.js'

describe('MCP endpoint (2026-07-28) and MCP Events', () => {
  it('validates per-request metadata and headers the way the spec requires', async () => {
    const w = new World()
    const { access } = await w.obtainToken()
    const noHeader = await w.rpc(access, 'server/discover', {}, 1, { 'mcp-protocol-version': null })
    expect(noHeader.status).toBe(400)
    expect(((await noHeader.json()) as { error: { code: number } }).error.code).toBe(-32020)

    const mismatch = await w.rpc(access, 'server/discover', {}, 1, { 'mcp-protocol-version': '2025-11-25' })
    expect(mismatch.status).toBe(400)
    expect(((await mismatch.json()) as { error: { code: number } }).error.code).toBe(-32020)

    const unsupported = await w.rpc(access, 'server/discover', {}, 1, { 'mcp-protocol-version': '2025-11-25', 'x-body-version': '2025-11-25' })
    expect(unsupported.status).toBe(400)
    const u = (await unsupported.json()) as { error: { code: number; data: { supported: string[] } } }
    expect(u.error.code).toBe(-32022)
    expect(u.error.data.supported).toEqual(['2026-07-28'])

    const methodMismatch = await w.rpc(access, 'server/discover', {}, 1, { 'mcp-method': 'tools/list' })
    expect(methodMismatch.status).toBe(400)

    const unknown = await w.rpc(access, 'prompts/list')
    expect(unknown.status).toBe(404)
    expect(((await unknown.json()) as { error: { code: number } }).error.code).toBe(-32601)

    const legacy = await w.app.request('/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }),
    })
    expect(legacy.status).toBe(404)
    expect(await legacy.text()).toContain('2026-07-28')

    const get = await w.app.request('/mcp')
    expect(get.status).toBe(405)
  })

  it('lists the one event with its schemas', async () => {
    const w = new World()
    const { access } = await w.obtainToken()
    const res = await w.rpc(access, 'events/list')
    const json = (await res.json()) as { result: { resultType: string; events: Array<{ name: string; delivery: string[]; inputSchema: unknown; payloadSchema: unknown }> } }
    expect(json.result.resultType).toBe('complete')
    expect(json.result.events).toHaveLength(1)
    expect(json.result.events[0]).toMatchObject({ name: 'lucy.ping', delivery: ['webhook'] })
    expect(json.result.events[0]!.inputSchema).toBeDefined()
    expect(json.result.events[0]!.payloadSchema).toBeDefined()
  })

  it('subscribes after verifying the callback, refreshes in place, and unsubscribes', async () => {
    const w = new World()
    const { access } = await w.obtainToken()
    const res = await w.subscribe(access)
    expect(res.status).toBe(200)
    const json = (await res.json()) as { result: { id: string; refreshBefore: string; cursor: null; truncated: boolean } }
    expect(json.result.id).toMatch(/^sub_/)
    expect(json.result.cursor).toBeNull()
    expect(json.result.truncated).toBe(false)
    expect(new Date(json.result.refreshBefore).getTime()).toBe(w.nowMs + 7 * 24 * 3600 * 1000)
    // The verification request is signed with the subscription secret, carries a
    // msg_verification_* id, and names the subscription id that is then returned.
    const verification = w.outbound.find(o => o.url === CALLBACK_URL)!
    expect(JSON.parse(verification.body)).toMatchObject({ type: 'verification' })
    expect(verification.headers['webhook-id']).toMatch(/^msg_verification_/)
    expect(verification.headers['x-mcp-subscription-id']).toBe(json.result.id)
    expect(verify(SECRET, verification.headers['webhook-id']!, Number(verification.headers['webhook-timestamp']), verification.body, verification.headers['webhook-signature']!)).toBe(true)

    // Refresh: same identity (owner, event, args, url) keeps the id and extends the lifetime.
    w.nowMs += 1000
    const again = await w.subscribe(access, CALLBACK_URL, SECRET, { ttlMs: 60_000 })
    const j2 = (await again.json()) as { result: { id: string; refreshBefore: string } }
    expect(j2.result.id).toBe(json.result.id)
    const reverification = w.outbound.filter(o => o.url === CALLBACK_URL && o.body.includes('verification')).at(-1)!
    expect(reverification.headers['x-mcp-subscription-id']).toBe(json.result.id) // the refresh verifies under the same id
    expect(new Date(j2.result.refreshBefore).getTime()).toBe(w.nowMs + 60_000)

    const un = await w.rpc(access, 'events/unsubscribe', { name: 'lucy.ping', arguments: {}, delivery: { mode: 'webhook', url: CALLBACK_URL } }, 3)
    expect(un.status).toBe(200)
    expect(((await un.json()) as { result: { resultType: string } }).result.resultType).toBe('complete')
    expect(await w.store.list('sub:')).toHaveLength(0)
  })

  it('refuses bad subscriptions: unknown event, arguments, http callback, private host, bad secret, failed challenge', async () => {
    const w = new World()
    const { access } = await w.obtainToken()
    const code = async (r: Response) => ((await r.json()) as { error: { code: number; data?: { reason?: string } } }).error
    expect((await code(await w.rpc(access, 'events/subscribe', { name: 'other.event', delivery: { mode: 'webhook', url: CALLBACK_URL, secret: SECRET } }))).code).toBe(-32602)
    expect((await code(await w.subscribe(access, CALLBACK_URL, SECRET, { arguments: { document_id: 'x' } }))).code).toBe(-32602)
    expect((await code(await w.subscribe(access, 'http://receiver.example.test/cb'))).data?.reason).toBe('invalid_url')
    expect((await code(await w.subscribe(access, 'https://private.example.test/cb'))).data?.reason).toBe('private_address')
    expect((await code(await w.subscribe(access, 'https://10.1.2.3/cb'))).data?.reason).toBe('private_address')
    expect((await code(await w.subscribe(access, CALLBACK_URL, 'whsec_short'))).code).toBe(-32602)
    // A secret the receiver does not hold: the receiver rejects the signed verification, so nothing is registered.
    const wrongSecret = await code(await w.subscribe(access, CALLBACK_URL, 'whsec_' + Buffer.alloc(32, 1).toString('base64')))
    expect(wrongSecret.code).toBe(-32015)
    expect(wrongSecret.data?.reason).toBe('challenge_failed')
    const failed = await code(await w.subscribe(access, 'https://other.example.test/cb')) // fake internet answers 404
    expect(failed.code).toBe(-32015)
    expect(failed.data?.reason).toBe('challenge_failed')
    expect(await w.store.list('sub:')).toHaveLength(0)
  })

  it('binds subscriptions to the token principal so another client cannot remove them', async () => {
    const w = new World()
    const { access } = await w.obtainToken()
    await w.subscribe(access)
    const subs = await w.store.list<{ owner: string; clientId: string }>('sub:')
    expect(subs[0]!.value).toMatchObject({ owner: 'ryan', clientId: 'https://chatgpt.com/oauth/client.json' })
  })
})
