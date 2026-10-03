import { createHash, createHmac, randomBytes, timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto'

export const b64url = (buf: Buffer | Uint8Array | string): string => Buffer.from(buf).toString('base64url')

export const sha256 = (s: string | Buffer): Buffer => createHash('sha256').update(s).digest()

export const hmac256 = (key: Buffer, s: string): Buffer => createHmac('sha256', key).update(s).digest()

export const randomToken = (prefix: string, bytes = 32): string => `${prefix}${b64url(randomBytes(bytes))}`

export const randomId = (prefix: string): string => `${prefix}${b64url(randomBytes(12))}`

/** Constant-time string equality (only the length can leak). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return nodeTimingSafeEqual(ab, bb)
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
