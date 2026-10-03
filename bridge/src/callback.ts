/**
 * Callback URL hygiene and verification, per the MCP Events draft as ChatGPT
 * implements it: https only, public addresses only, and a one-time challenge
 * the receiver must echo before a subscription is accepted.
 */
import { isIP } from 'node:net'
import type { Deps } from './deps.js'
import { b64url, isRecord, parseJson, safeEqual } from './util.js'
import { randomBytes } from 'node:crypto'
import { sign } from './webhooks.js'

export class CallbackError extends Error {
  constructor(
    readonly reason: 'invalid_url' | 'private_address' | 'challenge_failed' | 'timeout' | 'unreachable',
    message: string,
  ) {
    super(message)
  }
}

function isPrivateV4(ip: string): boolean {
  const p = ip.split('.').map(Number)
  const [a, b] = [p[0] ?? 0, p[1] ?? 0]
  return (
    a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) || a >= 224
  )
}

function isPrivateV6(ip: string): boolean {
  const l = ip.toLowerCase()
  if (l === '::' || l === '::1') return true
  if (l.startsWith('fe80:') || l.startsWith('fc') || l.startsWith('fd')) return true
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(l)
  return m ? isPrivateV4(m[1]!) : false
}

export const isPrivateAddress = (ip: string): boolean => (isIP(ip) === 4 ? isPrivateV4(ip) : isIP(ip) === 6 ? isPrivateV6(ip) : true)

/** Throws CallbackError unless `url` is https to a public host (resolved now). */
export async function assertPublicHttpsUrl(url: string, deps: Deps): Promise<URL> {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new CallbackError('invalid_url', 'callback url is not a valid URL')
  }
  if (u.protocol !== 'https:') throw new CallbackError('invalid_url', 'callback url must use https')
  if (u.username || u.password) throw new CallbackError('invalid_url', 'callback url must not carry credentials')
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new CallbackError('private_address', 'callback host is local')
  }
  const { allowedCallbackHosts } = deps.config
  if (allowedCallbackHosts.length > 0 && !allowedCallbackHosts.includes(host)) {
    throw new CallbackError('invalid_url', `callback host ${host} is not allowed`)
  }
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new CallbackError('private_address', 'callback address is not public')
    return u
  }
  let addrs: string[]
  try {
    addrs = await deps.resolve(host)
  } catch {
    throw new CallbackError('unreachable', `callback host ${host} does not resolve`)
  }
  if (addrs.length === 0) throw new CallbackError('unreachable', `callback host ${host} does not resolve`)
  if (addrs.some(isPrivateAddress)) throw new CallbackError('private_address', 'callback host resolves to a non-public address')
  return u
}

/**
 * POSTs a verification challenge, signed like a delivery with the subscription's
 * secret and carrying the subscription id, and requires the challenge echoed
 * back with a 2xx. The subscription id therefore exists before verification.
 */
export async function verifyCallback(url: string, secret: string, subscriptionId: string, deps: Deps): Promise<void> {
  const challenge = b64url(randomBytes(24))
  const body = JSON.stringify({ type: 'verification', challenge })
  const msgId = `msg_verification_${b64url(randomBytes(9))}`
  const ts = Math.floor(deps.now().getTime() / 1000)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), deps.config.verificationTimeoutMs)
  let res: Response
  try {
    res = await deps.fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'webhook-id': msgId,
        'webhook-timestamp': String(ts),
        'webhook-signature': sign(secret, msgId, ts, body),
        'X-MCP-Subscription-Id': subscriptionId,
      },
      body,
      signal: ctrl.signal,
    })
  } catch (err) {
    clearTimeout(timer)
    if ((err as Error)?.name === 'AbortError') throw new CallbackError('timeout', 'callback verification timed out')
    throw new CallbackError('unreachable', `callback verification request failed: ${(err as Error)?.message ?? err}`)
  }
  clearTimeout(timer)
  if (!res.ok) throw new CallbackError('challenge_failed', `callback verification answered HTTP ${res.status}`)
  const answer = parseJson(await res.text())
  if (!isRecord(answer) || typeof answer.challenge !== 'string' || !safeEqual(answer.challenge, challenge)) {
    throw new CallbackError('challenge_failed', 'callback did not echo the challenge')
  }
}
