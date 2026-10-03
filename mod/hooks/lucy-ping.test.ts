import { describe, expect, mock, test } from 'claude-code/testing'

const OPTIONS = { options: { bridge_url: 'https://bridge.example.test/', ping_token: 'test-ping-token' } }
const NOW = Date.UTC(2026, 9, 3, 12, 0, 0)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

type Call = { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }

// An op hook beneath the plugin answers with { value } (or { deny }).
function reply(status: number, body: unknown) {
  return { value: { status, ok: status >= 200 && status < 300, headers: { 'content-type': 'application/json' }, text: JSON.stringify(body) } }
}

function sentId(call: Call): string {
  return (JSON.parse(call.init!.body!) as { eventId: string }).eventId
}

describe('/lucy-ping', () => {
  test('sends one event with a fresh v4 event ID, a timestamp and the greeting, and never prints the token', OPTIONS, async ($, on) => {
    mock.store(on)
    mock.clock(on, { now: NOW })
    const calls: Call[] = []
    on('http.fetch', async (_$, e) => {
      calls.push(e)
      return reply(200, { eventId: sentId(e), status: 'delivered', deliveries: [{ subscriptionId: 'sub_1', status: 'delivered', httpStatus: 200, attempts: 1 }] })
    })

    const { text } = await $.command.run({ command: 'lucy-ping', args: '' })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://bridge.example.test/ping')
    expect(calls[0]!.init?.method).toBe('POST')
    expect(calls[0]!.init?.headers?.authorization).toBe('Bearer test-ping-token')
    const body = JSON.parse(calls[0]!.init!.body!) as { eventId: string; timestamp: string; greeting: string }
    expect(body.eventId).toMatch(UUID)
    expect(body.timestamp).toBe('2026-10-03T12:00:00.000Z')
    expect(body.greeting).toContain('Lucy')

    expect(text).toContain(body.eventId)
    expect(text).toContain('delivered')
    expect(text).not.toContain('test-ping-token')

    // Delivered: nothing is pending, so a retry has nothing to resend.
    const retry = await $.command.run({ command: 'lucy-ping', args: 'retry' })
    expect(retry.text).toContain('nothing to retry')
    expect(calls).toHaveLength(1)
  })

  test('keeps the SAME event ID across a failed send and /lucy-ping retry', OPTIONS, async ($, on) => {
    mock.store(on)
    mock.clock(on, { now: NOW })
    const calls: Call[] = []
    on('http.fetch', async (_$, e) => {
      calls.push(e)
      if (calls.length === 1) return reply(502, { error: 'upstream down' })
      return reply(200, { eventId: sentId(e), status: 'delivered', deliveries: [] })
    })

    const first = await $.command.run({ command: 'lucy-ping', args: '' })
    expect(first.text).toContain('NOT delivered')
    expect(first.text).toContain('upstream down')
    expect(first.text).toContain('retry')
    const id1 = sentId(calls[0]!)
    expect(first.text).toContain(id1)

    // A plain /lucy-ping while one is pending does not mint a new ID or send.
    const blocked = await $.command.run({ command: 'lucy-ping', args: '' })
    expect(blocked.text).toContain(id1)
    expect(blocked.text).toContain('still undelivered')
    expect(calls).toHaveLength(1)

    const second = await $.command.run({ command: 'lucy-ping', args: 'retry' })
    expect(calls).toHaveLength(2)
    expect(sentId(calls[1]!)).toBe(id1)
    expect(second.text).toContain('delivered')

    // Now a plain /lucy-ping mints a new ID.
    const third = await $.command.run({ command: 'lucy-ping', args: '' })
    expect(calls).toHaveLength(3)
    expect(sentId(calls[2]!)).not.toBe(id1)
    expect(third.text).toContain('delivered')
  })

  test('reports when the bridge has no subscriber yet and keeps the event for retry', OPTIONS, async ($, on) => {
    mock.store(on)
    mock.clock(on, { now: NOW })
    const calls: Call[] = []
    on('http.fetch', async (_$, e) => {
      calls.push(e)
      return reply(200, { eventId: sentId(e), status: calls.length === 1 ? 'no_subscribers' : 'delivered', deliveries: [] })
    })
    const { text } = await $.command.run({ command: 'lucy-ping', args: '' })
    expect(text).toContain('no active lucy.ping subscription')
    const retry = await $.command.run({ command: 'lucy-ping', args: 'retry' })
    expect(calls).toHaveLength(2)
    expect(sentId(calls[1]!)).toBe(sentId(calls[0]!))
    expect(retry.text).toContain('delivered')
  })

  test('status asks the bridge about the last event', OPTIONS, async ($, on) => {
    mock.store(on, { 'last-ping': { eventId: 'evt-fixed', timestamp: '2026-10-03T11:00:00.000Z', attempts: 1, status: 'delivered' } })
    mock.clock(on, { now: NOW })
    const calls: Call[] = []
    on('http.fetch', async (_$, e) => {
      calls.push(e)
      return reply(200, { eventId: 'evt-fixed', status: 'delivered', deliveries: [{ subscriptionId: 'sub_1', status: 'delivered', httpStatus: 200, attempts: 1 }] })
    })
    const { text } = await $.command.run({ command: 'lucy-ping', args: 'status' })
    expect(calls[0]!.url).toBe('https://bridge.example.test/ping/evt-fixed')
    expect(calls[0]!.init?.method).toBe('GET')
    expect(text).toContain('evt-fixed')
    expect(text).toContain('sub_1')
  })

  test('a network failure is reported without a crash and keeps the event for retry', OPTIONS, async ($, on) => {
    mock.store(on)
    mock.clock(on, { now: NOW })
    // The host refusing the request (DNS failure, connection refused, policy)
    // reaches the plugin as a rejected $.http.fetch; a deny beneath stands for it.
    on('http.fetch', async () => ({ deny: 'ECONNREFUSED' }))
    const { text } = await $.command.run({ command: 'lucy-ping', args: '' })
    expect(text).toContain('NOT delivered')
    expect(text).toContain('request failed')
    expect(text).toContain('retry')
  })

  // A missing required option never reaches the command: the engine refuses the
  // load itself, naming the field. The mod's own guard covers a non-https origin.
  test('refuses to send to a non-https bridge', { options: { bridge_url: 'http://bridge.example.test', ping_token: 't' } }, async ($, on) => {
    mock.store(on)
    let fetched = false
    on('http.fetch', async () => {
      fetched = true
      return reply(200, {})
    })
    const { text } = await $.command.run({ command: 'lucy-ping', args: '' })
    expect(text).toContain('https')
    expect(fetched).toBe(false)
  })
})
