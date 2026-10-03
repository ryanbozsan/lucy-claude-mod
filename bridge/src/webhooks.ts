/**
 * Standard Webhooks signing (https://www.standardwebhooks.com):
 *   signed content = `${msgId}.${timestampSeconds}.${body}`
 *   signature      = "v1," + base64(HMAC-SHA256(secretBytes, signedContent))
 *   secret         = "whsec_" + base64(24..64 random bytes)
 */
import { hmac256, isRecord } from './util.js'

export const SECRET_PREFIX = 'whsec_'

export function decodeSecret(secret: string): Buffer {
  if (!secret.startsWith(SECRET_PREFIX)) throw new Error('signing secret must start with whsec_')
  const raw = secret.slice(SECRET_PREFIX.length)
  if (!/^[A-Za-z0-9+/_-]+=*$/.test(raw)) throw new Error('signing secret is not base64')
  const key = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  if (key.length < 24 || key.length > 64) throw new Error(`signing secret must decode to 24–64 bytes (got ${key.length})`)
  return key
}

export function sign(secret: string, msgId: string, timestampSeconds: number, body: string): string {
  const key = decodeSecret(secret)
  return `v1,${hmac256(key, `${msgId}.${timestampSeconds}.${body}`).toString('base64')}`
}

/** Verifies a webhook-signature header (space-separated, any v1 entry may match). */
export function verify(secret: string, msgId: string, timestampSeconds: number, body: string, header: string): boolean {
  const expected = sign(secret, msgId, timestampSeconds, body)
  return header.split(' ').some(entry => entry === expected)
}

export type EventEnvelope = {
  eventId: string
  name: string
  timestamp: string
  data: Record<string, unknown>
  cursor: null
}

export const isEventEnvelope = (v: unknown): v is EventEnvelope =>
  isRecord(v) && typeof v.eventId === 'string' && typeof v.name === 'string' && typeof v.timestamp === 'string' && isRecord(v.data)
