import { Hono } from 'hono'
import type { Deps } from './deps.js'
import { mcpRoutes } from './mcp.js'
import { oauthRoutes } from './oauth/routes.js'
import { pingRoutes } from './ping.js'

export function createApp(deps: Deps): Hono {
  const app = new Hono()
  app.get('/', c => c.json({ name: 'lucy-bridge', ok: true, mcp: `${deps.config.publicUrl}/mcp` }))
  app.get('/healthz', c => c.json({ ok: true }))
  app.route('/', oauthRoutes(deps))
  app.route('/', mcpRoutes(deps))
  app.route('/', pingRoutes(deps))
  app.notFound(c => c.json({ error: 'not found' }, 404))
  app.onError((err, c) => {
    deps.log('unhandled', { message: err.message })
    return c.json({ error: 'internal error' }, 500)
  })
  return app
}
