import type { Engine, Register } from 'claude-code'

/**
 * /lucy-ping — one doorbell.
 *
 *   /lucy-ping          send a new event (fresh event ID) to the bridge
 *   /lucy-ping retry    resend the last undelivered event with the SAME event ID
 *   /lucy-ping status   ask the bridge what happened to the last event
 *
 * The mod never prints the token. Only the event ID, timestamp and the
 * bridge's reported delivery status reach the transcript.
 */

export const GREETING = 'Hello Lucy — this is Claude ringing your doorbell. No action needed; please acknowledge the event ID.'

const PENDING = 'pending-ping'
const LAST = 'last-ping'

type PingRecord = {
  eventId: string
  timestamp: string
  attempts: number
  status: 'pending' | 'delivered' | 'partial' | 'no_subscribers' | 'failed'
  detail?: string
}

type BridgeReply = {
  eventId?: string
  status?: string
  idempotent?: boolean
  deliveries?: Array<{ subscriptionId: string; httpStatus?: number; attempts?: number; status?: string }>
  error?: string
}

const USAGE = 'usage: /lucy-ping [retry|status]'

export const register: Register = (on, options) => {
  const bridgeUrl = String(options.bridge_url ?? '').trim().replace(/\/+$/, '')
  const token = String(options.ping_token ?? '').trim()

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'lucy-ping',
      description: "Ring Lucy's doorbell: send one test event through the bridge",
      argumentHint: '[retry|status]',
    })
    return next(e)
  })

  on('command.run', { command: 'lucy-ping' }, async ($, e) => {
    const arg = (e.args ?? '').trim()
    if (!bridgeUrl || !token) {
      return { text: 'lucy-ping: bridge_url and ping_token are not both set. Open /config → lucy-ping and fill them in.' }
    }
    if (!/^https:\/\//.test(bridgeUrl)) {
      return { text: `lucy-ping: bridge_url must be https (got a non-https origin).` }
    }

    const pending = (await $.store.get(PENDING)) as PingRecord | undefined

    if (arg === 'status') {
      const last = pending ?? ((await $.store.get(LAST)) as PingRecord | undefined)
      if (!last) return { text: 'lucy-ping: no event has been sent yet.' }
      const res = await safeFetch($, `${bridgeUrl}/ping/${encodeURIComponent(last.eventId)}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      })
      if (!res.ok) return { text: `lucy-ping status: bridge answered ${res.status} for event ${last.eventId}${res.detail ? ` — ${res.detail}` : ''}` }
      return { text: `lucy-ping status for ${last.eventId}: ${describe(res.body)}` }
    }

    let record: PingRecord
    if (arg === 'retry') {
      if (!pending) return { text: 'lucy-ping: nothing to retry — the last event was delivered (or none was sent). Run /lucy-ping for a new one.' }
      record = pending
    } else if (arg === '') {
      if (pending) {
        return {
          text: `lucy-ping: event ${pending.eventId} is still undelivered after ${pending.attempts} attempt(s). Run /lucy-ping retry to resend it with the same event ID, or /lucy-ping status.`,
        }
      }
      const nowMs = await $.clock.now()
      record = { eventId: crypto.randomUUID(), timestamp: new Date(nowMs).toISOString(), attempts: 0, status: 'pending' }
    } else {
      return { text: `lucy-ping: unknown argument "${arg}". ${USAGE}` }
    }

    record.attempts += 1
    await $.store.set(PENDING, record)

    const res = await safeFetch($, `${bridgeUrl}/ping`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ eventId: record.eventId, timestamp: record.timestamp, greeting: GREETING }),
    })

    if (!res.ok) {
      record.status = 'failed'
      record.detail = res.detail ?? `HTTP ${res.status}`
      await $.store.set(PENDING, record)
      return {
        text: `lucy-ping: event ${record.eventId} NOT delivered (attempt ${record.attempts}): bridge answered ${res.status}${res.detail ? ` — ${res.detail}` : ''}. Run /lucy-ping retry to resend with the same event ID.`,
      }
    }

    const reply = res.body
    const status = reply.status ?? 'unknown'
    if (status === 'delivered') {
      record.status = 'delivered'
      await $.store.delete(PENDING)
      await $.store.set(LAST, record)
      return {
        text: [
          `lucy-ping: event ${record.eventId} delivered to the bridge's subscriber(s) at ${record.timestamp}${reply.idempotent ? ' (already delivered earlier; not re-sent)' : ''}.`,
          `Next: check Lucy's chat for an acknowledgement of event ID ${record.eventId}.`,
        ].join('\n'),
      }
    }
    if (status === 'partial') {
      // Some subscriber got it, at least one did not: not done. Keep the same event ID for retry.
      record.status = 'partial'
      record.detail = describe(reply)
      await $.store.set(PENDING, record)
      return {
        text: `lucy-ping: event ${record.eventId} reached only some subscribers (${describe(reply)}). Run /lucy-ping retry to resend the same event ID to the rest.`,
      }
    }
    if (status === 'no_subscribers') {
      record.status = 'no_subscribers'
      record.detail = 'no active lucy.ping subscription'
      await $.store.set(PENDING, record)
      return {
        text: `lucy-ping: bridge accepted event ${record.eventId} but has no active lucy.ping subscription (Lucy has not subscribed yet). Subscribe in ChatGPT, then /lucy-ping retry.`,
      }
    }
    record.status = 'failed'
    record.detail = describe(reply)
    await $.store.set(PENDING, record)
    return {
      text: `lucy-ping: event ${record.eventId} was accepted but delivery ${status}: ${describe(reply)}. Run /lucy-ping retry to resend with the same event ID.`,
    }
  })
}

type Fetched = { ok: boolean; status: number; body: BridgeReply; detail?: string }

async function safeFetch(
  $: Engine,
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
): Promise<Fetched> {
  try {
    const res = await $.http.fetch(url, init)
    let body: BridgeReply = {}
    try {
      body = res.text ? (JSON.parse(res.text) as BridgeReply) : {}
    } catch {
      body = {}
    }
    const detail = body.error ?? (res.ok ? undefined : res.text?.slice(0, 160))
    return { ok: res.ok, status: res.status, body, detail }
  } catch (err) {
    return { ok: false, status: 0, body: {}, detail: `request failed: ${(err as Error)?.message ?? String(err)}` }
  }
}

function describe(reply: BridgeReply): string {
  const parts: string[] = []
  if (reply.status) parts.push(`status=${reply.status}`)
  for (const d of reply.deliveries ?? []) {
    parts.push(`${d.subscriptionId}: ${d.status ?? ''}${d.httpStatus ? ` http ${d.httpStatus}` : ''}${d.attempts ? ` after ${d.attempts} attempt(s)` : ''}`.trim())
  }
  if (reply.error) parts.push(`error=${reply.error}`)
  return parts.length ? parts.join('; ') : 'no detail'
}
