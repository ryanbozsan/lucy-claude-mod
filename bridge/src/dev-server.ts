import { serve } from '@hono/node-server'
import { buildApp } from './runtime.js'

const port = Number(process.env.PORT ?? 8787)
serve({ fetch: buildApp().fetch, port }, () => console.log(`lucy-bridge listening on http://localhost:${port}`))
