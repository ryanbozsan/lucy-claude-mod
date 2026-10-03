import { describe, expect, it } from 'vitest'
import { verify } from '../src/webhooks.js'
import { CALLBACK_URL, CALLBACK_URL_2, SECRET, SECRET_2, World } from './helpers.js'

type Reply = { eventId: string; status: string; idempotent?: boolean; deliveries: Array<{ subscriptionId: string; status: string; httpStatus?: number; attempts: number }> }

describe('POST /ping (the doorbell button)', () => {
  it('requires the ping token and a well-formed body', async () => {
    const w = new World()
    expect((await w.ping('11111111-1111-4111-8111-111111111111', undefined, 'wrong')).status).toBe(401)
    expect((await w.ping('short')).status).toBe(400)
    expect((await w.ping('11111111-1111-4111-8111-111111111111', 'not a date')).status).toBe(400)
  })

  it('reports no_subscribers before Lucy subscribes, then delivers the same event on retry', async () => {
    const w = new World()
    const id = '11111111-1111-4111-8111-111111111111'
    const first = (await (await w.ping(id)).json()) as Reply
    expect(first.status).toBe('no_subscribers')
    const { access } = await w.obtainToken()
    await w.subscribe(access)
    const second = (await (await w.ping(id)).json()) as Reply
    expect(second.status).toBe('delivered')
    expect(w.deliveries).toHaveLength(1)
    expect(JSON.parse(w.deliveries[0]!.body).eventId).toBe(id)
  })

  it('delivers a correctly signed Standard Webhooks request with the documented envelope', async () => {
    const w = new World()
    const { access } = await w.obtainToken()
    const sub = (await (await w.subscribe(access)).json()) as { result: { id: string } }
    const id = '22222222-2222-4222-8222-222222222222'
    const res = await w.ping(id, '2026-10-03T12:00:00.000Z')
    expect(res.status).toBe(200)
    const reply = (await res.json()) as Reply
    expect(reply.status).toBe('delivered')
    expect(reply.deliveries[0]).toMatchObject({ subscriptionId: sub.result.id, status: 'delivered', httpStatus: 200, attempts: 1 })

    const d = w.deliveries[0]!
    expect(d.headers['content-type']).toBe('application/json')
    expect(d.headers['webhook-id']).toBe(id)
    expect(d.headers['x-mcp-subscription-id']).toBe(sub.result.id)
    const ts = Number(d.headers['webhook-timestamp'])
    expect(ts).toBe(Math.floor(w.nowMs / 1000))
    expect(verify(SECRET, id, ts, d.body, d.headers['webhook-signature']!)).toBe(true)
    const body = JSON.parse(d.body) as { eventId: string; name: string; timestamp: string; data: Record<string, unknown>; cursor: null }
    expect(body).toMatchObject({ eventId: id, name: 'lucy.ping', timestamp: '2026-10-03T12:00:00.000Z', cursor: null })
    expect(body.data).toMatchObject({ eventId: id, sentAt: '2026-10-03T12:00:00.000Z', source: 'claude-code/lucy-ping' })
    expect(typeof body.data.greeting).toBe('string')
    expect(d.body.length).toBeLessThan(256 * 1024)
  })

  it('retries transient failures with the same event ID and a fresh signature, and is idempotent once delivered', async () => {
    const w = new World()
    const { access } = await w.obtainToken()
    await w.subscribe(access)
    const id = '33333333-3333-4333-8333-333333333333'
    w.receiverStatuses = [500, 503, 200]
    const reply = (await (await w.ping(id)).json()) as Reply
    expect(reply.status).toBe('delivered')
    expect(reply.deliveries[0]!.attempts).toBe(3)
    expect(w.deliveries).toHaveLength(3)
    const ids = w.deliveries.map(d => d.headers['webhook-id'])
    expect(new Set(ids)).toEqual(new Set([id]))
    const stamps = w.deliveries.map(d => d.headers['webhook-timestamp'])
    expect(new Set(stamps).size).toBeGreaterThan(1) // fresh signing time per attempt
    const sigs = w.deliveries.map(d => d.headers['webhook-signature'])
    expect(new Set(sigs).size).toBe(3)

    const again = (await (await w.ping(id)).json()) as Reply
    expect(again.idempotent).toBe(true)
    expect(w.deliveries).toHaveLength(3)
  })

  it('gives up after bounded attempts, keeps the event for a later retry with the same ID', async () => {
    const w = new World()
    const { access } = await w.obtainToken()
    await w.subscribe(access)
    const id = '44444444-4444-4444-8444-444444444444'
    w.receiverStatuses = [500, 500, 500]
    const reply = (await (await w.ping(id)).json()) as Reply
    expect(reply.status).toBe('failed')
    expect(reply.deliveries[0]!.attempts).toBe(3)
    w.receiverStatuses = [200]
    const retry = (await (await w.ping(id)).json()) as Reply
    expect(retry.status).toBe('delivered')
    expect(retry.deliveries[0]!.attempts).toBe(4)
    expect(w.deliveries.every(d => d.headers['webhook-id'] === id)).toBe(true)
    const status = (await (await w.app.request(`/ping/${id}`, { headers: { authorization: 'Bearer ping-token-for-tests' } })).json()) as Reply
    expect(status.status).toBe('delivered')
  })

  it('retires a subscription on 410 and does not retry 413', async () => {
    const w = new World()
    const { access } = await w.obtainToken()
    await w.subscribe(access)
    w.receiverStatuses = [410]
    const gone = (await (await w.ping('55555555-5555-4555-8555-555555555555')).json()) as Reply
    expect(gone.status).toBe('failed')
    expect(gone.deliveries[0]).toMatchObject({ status: 'gone', attempts: 1 })
    const after = (await (await w.ping('66666666-6666-4666-8666-666666666666')).json()) as Reply
    expect(after.status).toBe('no_subscribers')

    const w2 = new World()
    const t2 = await w2.obtainToken()
    await w2.subscribe(t2.access)
    w2.receiverStatuses = [413]
    const big = (await (await w2.ping('77777777-7777-4777-8777-777777777777')).json()) as Reply
    expect(big.deliveries[0]).toMatchObject({ status: 'rejected', attempts: 1 })
  })

  it('reports partial when one subscriber fails, and a retry reaches only the one still missing', async () => {
    const w = new World()
    const { access } = await w.obtainToken()
    await w.subscribe(access, CALLBACK_URL, SECRET)
    await w.subscribe(access, CALLBACK_URL_2, SECRET_2)
    const id = '99999999-9999-4999-8999-999999999999'
    w.receiverStatusesByUrl[CALLBACK_URL_2] = [500, 500, 500]
    const first = (await (await w.ping(id)).json()) as Reply
    expect(first.status).toBe('partial')
    expect(first.idempotent).toBeUndefined()
    const byUrl = (u: string) => w.deliveries.filter(d => d.url === u).length
    expect(byUrl(CALLBACK_URL)).toBe(1)
    expect(byUrl(CALLBACK_URL_2)).toBe(3)

    const retry = (await (await w.ping(id)).json()) as Reply
    expect(retry.status).toBe('delivered')
    expect(byUrl(CALLBACK_URL)).toBe(1) // the one that already had it is not sent again
    expect(byUrl(CALLBACK_URL_2)).toBe(4)
    expect(w.deliveries.every(d => d.headers['webhook-id'] === id)).toBe(true)

    const third = (await (await w.ping(id)).json()) as Reply
    expect(third.idempotent).toBe(true)
  })

  it('does not deliver to an expired subscription', async () => {
    const w = new World()
    const { access } = await w.obtainToken()
    await w.subscribe(access, undefined, undefined, { ttlMs: 1000 })
    w.nowMs += 2000
    const reply = (await (await w.ping('88888888-8888-4888-8888-888888888888')).json()) as Reply
    expect(reply.status).toBe('no_subscribers')
  })
})
