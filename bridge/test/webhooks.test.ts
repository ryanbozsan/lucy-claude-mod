import { describe, expect, it } from 'vitest'
import { Webhook } from 'standardwebhooks'
import { decodeSecret, sign, verify } from '../src/webhooks.js'
import { SECRET } from './helpers.js'

describe('Standard Webhooks signing', () => {
  it('signs msgId.timestamp.body with HMAC-SHA256 as v1,<base64>', () => {
    const sig = sign(SECRET, 'evt_1', 1700000000, '{"a":1}')
    expect(sig).toMatch(/^v1,[A-Za-z0-9+/]+=*$/)
    expect(verify(SECRET, 'evt_1', 1700000000, '{"a":1}', sig)).toBe(true)
    expect(verify(SECRET, 'evt_1', 1700000001, '{"a":1}', sig)).toBe(false)
    expect(verify(SECRET, 'evt_2', 1700000000, '{"a":1}', sig)).toBe(false)
    expect(verify(SECRET, 'evt_1', 1700000000, '{"a":2}', sig)).toBe(false)
  })

  it('interoperates with the reference standardwebhooks library', () => {
    const body = '{"eventId":"evt_9","name":"lucy.ping"}'
    const ts = Math.floor(Date.now() / 1000) // the reference verifier enforces a freshness window
    const ours = sign(SECRET, 'evt_9', ts, body)
    const theirs = new Webhook(SECRET)
    expect(theirs.sign('evt_9', new Date(ts * 1000), body)).toBe(ours)
    const verified = theirs.verify(body, { 'webhook-id': 'evt_9', 'webhook-timestamp': String(ts), 'webhook-signature': ours } as Record<string, string>)
    expect(verified).toEqual(JSON.parse(body))
  })

  it('rejects secrets outside the whsec_ 24–64 byte rule', () => {
    expect(() => decodeSecret('nope')).toThrow(/whsec_/)
    expect(() => decodeSecret('whsec_' + Buffer.alloc(8).toString('base64'))).toThrow(/24–64/)
    expect(() => decodeSecret('whsec_' + Buffer.alloc(65).toString('base64'))).toThrow(/24–64/)
    expect(decodeSecret('whsec_' + Buffer.alloc(24).toString('base64'))).toHaveLength(24)
  })
})
