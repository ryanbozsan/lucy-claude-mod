import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { CHATGPT_CIMD, CLIENT_ID, PUBLIC_URL, REDIRECT_URI, World } from './helpers.js'

const form = (o: Record<string, string>) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() })

describe('OAuth 2.1 (bridge as authorization server + resource server)', () => {
  it('publishes protected-resource and authorization-server metadata ChatGPT needs', async () => {
    const w = new World()
    const prm = await (await w.app.request('/.well-known/oauth-protected-resource')).json()
    expect(prm).toMatchObject({ resource: `${PUBLIC_URL}/mcp`, authorization_servers: [PUBLIC_URL], scopes_supported: ['events'] })
    const prm2 = await (await w.app.request('/.well-known/oauth-protected-resource/mcp')).json()
    expect(prm2).toEqual(prm)
    const as = await (await w.app.request('/.well-known/oauth-authorization-server')).json()
    expect(as).toMatchObject({
      issuer: PUBLIC_URL,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      grant_types_supported: ['authorization_code', 'refresh_token'],
    })
  })

  it('challenges an unauthenticated /mcp request with resource_metadata', async () => {
    const w = new World()
    const res = await w.app.request('/mcp', { method: 'POST', body: '{}' })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toContain(`resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp"`)
    expect(res.headers.get('www-authenticate')).toContain('scope="events"')
  })

  it("accepts ChatGPT's real client document (prefers private_key_jwt, also supports none) and rejects one without none", async () => {
    const w = new World()
    expect(w.cimd).toBe(CHATGPT_CIMD)
    expect(w.cimd.token_endpoint_auth_method).toBe('private_key_jwt')
    const { access } = await w.obtainToken()
    expect((await w.rpc(access, 'server/discover')).status).toBe(200)

    const w2 = new World()
    w2.cimd = { ...CHATGPT_CIMD, token_endpoint_auth_methods_supported: ['private_key_jwt'] }
    await expect(w2.obtainToken()).rejects.toThrow(/authorize page: 400/)
  })

  it('completes CIMD + PKCE + consent and the token works on /mcp', async () => {
    const w = new World()
    const { access } = await w.obtainToken()
    expect(w.outbound.some(o => o.url === CLIENT_ID)).toBe(true) // the client document was fetched
    const res = await w.rpc(access, 'server/discover')
    expect(res.status).toBe(200)
    const json = (await res.json()) as { result: { supportedVersions: string[]; capabilities: Record<string, unknown> } }
    expect(json.result.supportedVersions).toEqual(['2026-07-28'])
    expect(json.result.capabilities).toHaveProperty('events')
  })

  it('refuses a wrong passphrase, a wrong PKCE verifier, and a used code', async () => {
    const w = new World()
    await expect(w.obtainToken({ passphrase: 'wrong' })).rejects.toThrow(/consent: 401/)
    expect(w.logs.some(l => l.line === 'oauth.consent.denied')).toBe(true)

    // Walk to a code manually, then present a bad verifier.
    const verifier = 'a'.repeat(43)
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const q = new URLSearchParams({ response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, code_challenge: challenge, code_challenge_method: 'S256', resource: `${PUBLIC_URL}/mcp` })
    const html = await (await w.app.request(`/oauth/authorize?${q}`)).text()
    const requestId = /name="request_id" value="([^"]+)"/.exec(html)![1]!
    const approved = await w.app.request('/oauth/authorize', form({ request_id: requestId, passphrase: 'correct horse battery staple' }))
    const code = new URL(approved.headers.get('location')!).searchParams.get('code')!
    const bad = await w.app.request('/oauth/token', form({ grant_type: 'authorization_code', code, code_verifier: 'b'.repeat(43), client_id: CLIENT_ID }))
    expect(bad.status).toBe(400)
    expect((await bad.json()) as object).toMatchObject({ error: 'invalid_grant' })
    // The code is single use: even the right verifier fails now.
    const again = await w.app.request('/oauth/token', form({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: CLIENT_ID }))
    expect(again.status).toBe(400)
  })

  it('never redirects on a client or redirect_uri problem, and only allows listed client_ids', async () => {
    const w = new World()
    const q = (o: Record<string, string>) => new URLSearchParams({ response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', ...o })
    const badRedirect = await w.app.request(`/oauth/authorize?${q({ redirect_uri: 'https://evil.example.test/cb' })}`)
    expect(badRedirect.status).toBe(400)
    expect(badRedirect.headers.get('location')).toBeNull()
    const strangerClient = await w.app.request(`/oauth/authorize?${q({ client_id: 'https://stranger.example.test/client.json' })}`)
    expect(strangerClient.status).toBe(400)
    expect(await strangerClient.text()).toContain('unauthorized_client')
    // A bad resource DOES redirect with an error (the client is legitimate).
    const badResource = await w.app.request(`/oauth/authorize?${q({ resource: 'https://other.example.test/mcp' })}`)
    expect(badResource.status).toBe(302)
    expect(new URL(badResource.headers.get('location')!).searchParams.get('error')).toBe('invalid_target')
  })

  it('redeems a code and rotates a refresh token at most once under concurrency', async () => {
    const w = new World()
    const verifier = 'c'.repeat(43)
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const q = new URLSearchParams({ response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, code_challenge: challenge, code_challenge_method: 'S256', resource: `${PUBLIC_URL}/mcp` })
    const html = await (await w.app.request(`/oauth/authorize?${q}`)).text()
    const requestId = /name="request_id" value="([^"]+)"/.exec(html)![1]!
    const consent = form({ request_id: requestId, passphrase: 'correct horse battery staple' })
    const [a1, a2] = await Promise.all([w.app.request('/oauth/authorize', consent), w.app.request('/oauth/authorize', consent)])
    expect([a1.status, a2.status].sort()).toEqual([302, 400]) // the approval request itself is single use
    const code = new URL((a1.status === 302 ? a1 : a2).headers.get('location')!).searchParams.get('code')!
    const redeem = form({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: CLIENT_ID })
    const results = await Promise.all([w.app.request('/oauth/token', redeem), w.app.request('/oauth/token', redeem)])
    expect(results.map(r => r.status).sort()).toEqual([200, 400])
    const { refresh_token } = (await results.find(r => r.status === 200)!.json()) as { refresh_token: string }
    const rotate = form({ grant_type: 'refresh_token', refresh_token, client_id: CLIENT_ID })
    const rotated = await Promise.all([w.app.request('/oauth/token', rotate), w.app.request('/oauth/token', rotate)])
    expect(rotated.map(r => r.status).sort()).toEqual([200, 400])
  })

  it('rotates refresh tokens and rejects a reused one', async () => {
    const w = new World()
    const { refresh } = await w.obtainToken()
    const r1 = await w.app.request('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: refresh, client_id: CLIENT_ID }))
    expect(r1.status).toBe(200)
    const j1 = (await r1.json()) as { access_token: string; refresh_token: string }
    expect(j1.refresh_token).not.toBe(refresh)
    const r2 = await w.app.request('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: refresh, client_id: CLIENT_ID }))
    expect(r2.status).toBe(400)
    expect((await w.rpc(j1.access_token, 'server/discover')).status).toBe(200)
  })

  it('expires access tokens', async () => {
    const w = new World()
    const { access } = await w.obtainToken()
    w.nowMs += 3601 * 1000
    expect((await w.rpc(access, 'server/discover')).status).toBe(401)
  })

  it('supports Dynamic Client Registration only for allowed redirect hosts', async () => {
    const w = new World()
    const ok = await w.app.request('/oauth/register', { method: 'POST', body: JSON.stringify({ client_name: 'ChatGPT', redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'none' }) })
    expect(ok.status).toBe(201)
    const { client_id } = (await ok.json()) as { client_id: string }
    expect(client_id).toMatch(/^lcb_client_/)
    const { access } = await w.obtainToken({ clientId: client_id })
    expect((await w.rpc(access, 'events/list')).status).toBe(200)
    const bad = await w.app.request('/oauth/register', { method: 'POST', body: JSON.stringify({ redirect_uris: ['https://evil.example.test/cb'] }) })
    expect(bad.status).toBe(400)
  })
})
