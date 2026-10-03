/**
 * The bridge's persistence. ChatGPT requires subscriptions to survive restarts,
 * and a Vercel function keeps nothing between cold starts, so production uses
 * Upstash Redis over REST. Tests and local runs use MemoryStore.
 */
export interface Store {
  get<T = unknown>(key: string): Promise<T | undefined>
  set(key: string, value: unknown, opts?: { ttlSeconds?: number }): Promise<void>
  delete(key: string): Promise<void>
  /** Every value whose key starts with `prefix`. Small collections only. */
  list<T = unknown>(prefix: string): Promise<Array<{ key: string; value: T }>>
}

export class MemoryStore implements Store {
  private readonly map = new Map<string, { value: string; expiresAt?: number }>()
  constructor(private readonly now: () => number = () => Date.now()) {}

  async get<T>(key: string): Promise<T | undefined> {
    const row = this.map.get(key)
    if (!row) return undefined
    if (row.expiresAt !== undefined && row.expiresAt <= this.now()) {
      this.map.delete(key)
      return undefined
    }
    return JSON.parse(row.value) as T
  }
  async set(key: string, value: unknown, opts?: { ttlSeconds?: number }): Promise<void> {
    this.map.set(key, {
      value: JSON.stringify(value),
      expiresAt: opts?.ttlSeconds !== undefined ? this.now() + opts.ttlSeconds * 1000 : undefined,
    })
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key)
  }
  async list<T>(prefix: string): Promise<Array<{ key: string; value: T }>> {
    const out: Array<{ key: string; value: T }> = []
    for (const key of [...this.map.keys()]) {
      if (!key.startsWith(prefix)) continue
      const value = await this.get<T>(key)
      if (value !== undefined) out.push({ key, value })
    }
    return out
  }
}

type UpstashLike = {
  get: (key: string) => Promise<unknown>
  set: (key: string, value: string, opts: { ex: number }) => Promise<unknown>
  del: (key: string) => Promise<unknown>
  scan: (cursor: string | number, opts: { match: string; count?: number }) => Promise<[string | number, string[]]>
}

export class UpstashStore implements Store {
  constructor(private readonly redis: UpstashLike) {}

  async get<T>(key: string): Promise<T | undefined> {
    const raw = await this.redis.get(key)
    if (raw === null || raw === undefined) return undefined
    // @upstash/redis auto-deserializes JSON; tolerate both shapes.
    return typeof raw === 'string' ? (JSON.parse(raw) as T) : (raw as T)
  }
  async set(key: string, value: unknown, opts?: { ttlSeconds?: number }): Promise<void> {
    const text = JSON.stringify(value)
    if (opts?.ttlSeconds !== undefined) await this.redis.set(key, text, { ex: Math.max(1, Math.ceil(opts.ttlSeconds)) })
    else await (this.redis.set as (key: string, value: string) => Promise<unknown>)(key, text)
  }
  async delete(key: string): Promise<void> {
    await this.redis.del(key)
  }
  async list<T>(prefix: string): Promise<Array<{ key: string; value: T }>> {
    const out: Array<{ key: string; value: T }> = []
    let cursor: string | number = 0
    do {
      const [next, keys] = await this.redis.scan(cursor, { match: `${prefix}*`, count: 100 })
      cursor = next
      for (const key of keys) {
        const value = await this.get<T>(key)
        if (value !== undefined) out.push({ key, value })
      }
    } while (String(cursor) !== '0')
    return out
  }
}
