import { lookup } from 'node:dns/promises'
import type { Config } from './config.js'
import type { Store } from './store.js'

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export type Deps = {
  config: Config
  store: Store
  /** Outbound HTTP: webhook deliveries, callback verification, CIMD fetches. */
  fetch: FetchLike
  now: () => Date
  sleep: (ms: number) => Promise<void>
  /** Resolves a hostname to its addresses, for the public-address check on callbacks. */
  resolve: (hostname: string) => Promise<string[]>
  log: (line: string, fields?: Record<string, unknown>) => void
}

export function defaultDeps(config: Config, store: Store): Deps {
  return {
    config,
    store,
    fetch: (url, init) => fetch(url, init),
    now: () => new Date(),
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    resolve: async hostname => (await lookup(hostname, { all: true })).map(a => a.address),
    log: (line, fields) => console.log(JSON.stringify({ line, ...fields })),
  }
}
