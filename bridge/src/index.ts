/**
 * Vercel Hono preset entry. The preset requires this file to import `hono`
 * and default-export the app.
 */
import { Hono } from 'hono'
import { buildApp } from './runtime.js'

const app = buildApp()
if (!(app instanceof Hono)) throw new Error('buildApp did not return a Hono app')

export default app
