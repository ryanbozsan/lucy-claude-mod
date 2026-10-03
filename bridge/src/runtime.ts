/** Wires real config and storage for a deployed or locally run bridge. */
import { Redis } from '@upstash/redis'
import { createApp } from './create-app.js'
import { configFromEnv } from './config.js'
import { defaultDeps } from './deps.js'
import { MemoryStore, UpstashStore, type Store } from './store.js'

export function buildApp(env: Record<string, string | undefined> = process.env) {
  const config = configFromEnv(env)
  let store: Store
  // The Vercel Marketplace install of "Upstash for Redis" injects KV_REST_API_*;
  // a direct Upstash setup uses UPSTASH_REDIS_REST_*. Accept either.
  const redisUrl = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL
  const redisToken = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN
  if (redisUrl && redisToken) {
    store = new UpstashStore(new Redis({ url: redisUrl, token: redisToken }))
  } else if (env.VERCEL) {
    throw new Error('KV_REST_API_URL/KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_URL/TOKEN) are required on Vercel: subscriptions must survive cold starts')
  } else {
    console.warn('lucy-bridge: no Upstash configured; using in-memory store (dev only)')
    store = new MemoryStore()
  }
  return createApp(defaultDeps(config, store))
}
