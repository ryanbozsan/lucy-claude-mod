/**
 * POST /ping — the doorbell button the lucy-ping mod presses.
 * Idempotent on eventId: a retry with the same eventId re-delivers only what
 * was not yet delivered, and never mints a new event.
 */
import { Hono } from 'hono'
import type { Deps } from './deps.js'
import { LUCY_PING, subKey, type Subscription } from './events.js'
import { activeSubscriptions } from './mcp.js'
import { isRecord, parseJson, safeEqual } from './util.js'
import { sign, type EventEnvelope } from './webhooks.js'

export type DeliveryRecord = {
  subscriptionId: string
  status: 'delivered' | 'failed' | 'gone' | 'rejected'
  httpStatus?: number
  attempts: number
  lastError?: string
  deliveredAt?: string
}

export type PingRecord = {
  eventId: string
  receivedAt: string
  event: EventEnvelope
  status: 'delivered' | 'failed' | 'no_subscribers'
  deliveries: DeliveryRecord[]
  pings: number
}

export const pingKey = (eventId: string): string => `ping:${eventId}`
const EVENT_ID = /^[A-Za-z0-9._:-]{8,128}$/

async function deliverOnce(sub: Subscription, event: EventEnvelope, prior: DeliveryRecord | undefined, deps: Deps): Promise<DeliveryRecord> {
  const body = JSON.stringify(event)
  const rec: DeliveryRecord = prior ?? { subscriptionId: sub.id, status: 'failed', attempts: 0 }
  const { deliveryAttempts, deliveryTimeoutMs } = deps.config
  for (let i = 0; i < deliveryAttempts; i++) {
    if (i > 0) await deps.sleep(1000 * 2 ** (i - 1)) // 1s, 2s: distinct signing seconds per attempt
    rec.attempts += 1
    // Same event ID every time; a fresh signing timestamp and signature per attempt.
    const ts = Math.floor(deps.now().getTime() / 1000)
    const headers = {
      'content-type': 'application/json',
      'webhook-id': event.eventId,
      'webhook-timestamp': String(ts),
      'webhook-signature': sign(sub.secret, event.eventId, ts, body),
      'X-MCP-Subscription-Id': sub.id,
    }
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), deliveryTimeoutMs)
    try {
      const res = await deps.fetch(sub.url, { method: 'POST', headers, body, signal: ctrl.signal })
      rec.httpStatus = res.status
      if (res.ok) {
        rec.status = 'delivered'
        rec.deliveredAt = deps.now().toISOString()
        rec.lastError = undefined
        return rec
      }
      if (res.status === 410) {
        rec.status = 'gone'
        rec.lastError = 'receiver answered 410 Gone; subscription retired'
        await deps.store.set(subKey(sub.id), { ...sub, deadAt: deps.now().toISOString() } satisfies Subscription)
        return rec
      }
      if (res.status === 413) {
        rec.status = 'rejected'
        rec.lastError = 'receiver answered 413 Payload Too Large; not retried'
        return rec
      }
      rec.lastError = `HTTP ${res.status}`
    } catch (err) {
      rec.lastError = (err as Error)?.name === 'AbortError' ? 'timeout' : `request failed: ${(err as Error)?.message ?? err}`
    } finally {
      clearTimeout(timer)
    }
  }
  rec.status = 'failed'
  return rec
}

export function pingRoutes(deps: Deps): Hono {
  const app = new Hono()

  const authed = (authorization: string | undefined): boolean => {
    const m = /^Bearer\s+(\S+)$/i.exec(authorization ?? '')
    return !!m && safeEqual(m[1]!, deps.config.pingToken)
  }

  app.post('/ping', async c => {
    if (!authed(c.req.header('authorization'))) return c.json({ error: 'unauthorized' }, 401)
    const body = parseJson(await c.req.text())
    if (!isRecord(body)) return c.json({ error: 'body must be a JSON object' }, 400)
    const { eventId, timestamp, greeting } = body
    if (typeof eventId !== 'string' || !EVENT_ID.test(eventId)) return c.json({ error: 'eventId must be 8–128 chars of [A-Za-z0-9._:-]' }, 400)
    if (typeof timestamp !== 'string' || Number.isNaN(Date.parse(timestamp))) return c.json({ error: 'timestamp must be ISO-8601' }, 400)
    if (typeof greeting !== 'string' || greeting.length === 0 || greeting.length > 500) return c.json({ error: 'greeting must be 1–500 chars' }, 400)

    const key = pingKey(eventId)
    let record = await deps.store.get<PingRecord>(key)
    if (record && record.status === 'delivered') {
      deps.log('ping.idempotent', { eventId })
      return c.json({ ...record, idempotent: true })
    }
    const event: EventEnvelope = record?.event ?? {
      eventId,
      name: LUCY_PING,
      timestamp: new Date(timestamp).toISOString(),
      data: { eventId, greeting, sentAt: new Date(timestamp).toISOString(), source: 'claude-code/lucy-ping' },
      cursor: null,
    }
    record = record ?? { eventId, receivedAt: deps.now().toISOString(), event, status: 'no_subscribers', deliveries: [], pings: 0 }
    record.pings += 1

    const subs = await activeSubscriptions(deps, deps.config.ownerSubject, LUCY_PING)
    if (subs.length === 0) {
      record.status = 'no_subscribers'
      await deps.store.set(key, record, { ttlSeconds: 30 * 24 * 3600 })
      deps.log('ping.no_subscribers', { eventId })
      return c.json(record)
    }
    const deliveries: DeliveryRecord[] = []
    for (const sub of subs) {
      const prior = record.deliveries.find(d => d.subscriptionId === sub.id)
      if (prior?.status === 'delivered') {
        deliveries.push(prior)
        continue
      }
      deliveries.push(await deliverOnce(sub, event, prior, deps))
    }
    // Keep history for subscriptions no longer active.
    for (const d of record.deliveries) if (!deliveries.some(x => x.subscriptionId === d.subscriptionId)) deliveries.push(d)
    record.deliveries = deliveries
    record.status = deliveries.some(d => d.status === 'delivered') ? 'delivered' : 'failed'
    await deps.store.set(key, record, { ttlSeconds: 30 * 24 * 3600 })
    deps.log('ping.result', { eventId, status: record.status, deliveries: deliveries.map(d => ({ id: d.subscriptionId, status: d.status, http: d.httpStatus, attempts: d.attempts })) })
    return c.json(record)
  })

  app.get('/ping/:eventId', async c => {
    if (!authed(c.req.header('authorization'))) return c.json({ error: 'unauthorized' }, 401)
    const record = await deps.store.get<PingRecord>(pingKey(c.req.param('eventId')))
    if (!record) return c.json({ error: 'unknown eventId' }, 404)
    return c.json(record)
  })

  return app
}
