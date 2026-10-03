/** Wires real config and storage for a deployed or locally run bridge. */
import { Redis } from '@upstash/redis'
import { createApp } from './create-app.js'
import { configFromEnv } from './config.js'
import { defaultDeps } from './deps.js'
import { MemoryStore, UpstashStore, type Store } from './store.js'

export function buildApp(env: Record<string, string | undefined> = process.env) {
  const config = configFromEnv(env)
  let store: Store
  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
    store = new UpstashStore(new Redis({ url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN }))
  } else if (env.VERCEL) {
    throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required on Vercel: subscriptions must survive cold starts')
  } else {
    console.warn('lucy-bridge: no Upstash configured; using in-memory store (dev only)')
    store = new MemoryStore()
  }
  return createApp(defaultDeps(config, store))
}
