import { handle } from 'hono/vercel'
import { buildApp } from '../src/runtime.js'

export default handle(buildApp())
