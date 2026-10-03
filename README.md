# lucy-claude-mod

One doorbell. A Claude Code **mod** adds `/lucy-ping`; a small **bridge** turns that into a signed
[MCP Events](https://developers.openai.com/plugins/build/mcp-events) webhook that ChatGPT delivers to
Lucy (an existing ChatGPT Dot). Success means Lucy acknowledges the same event ID in her chat.

```
/lucy-ping  (Claude Code mod, MacBook)
   │  POST /ping   Authorization: Bearer <BRIDGE_PING_TOKEN>        ← our auth, mod → bridge
   ▼
bridge  (Vercel + Upstash Redis)
   │  MCP endpoint /mcp  (protocol 2026-07-28; OAuth 2.1 bearer)      ← ChatGPT → bridge
   │  events/list · events/subscribe · events/unsubscribe
   │  Signed webhook POST (Standard Webhooks) {eventId, name:"lucy.ping", timestamp, data}
   ▼
ChatGPT subscription owned by Lucy's account  →  Lucy's dot runs her instruction
   ▼
Lucy's chat shows the event ID   ← proof C
```

## Layout

| Path | What |
| --- | --- |
| `mod/` | The Claude Code plugin. `hooks/register.ts` registers `/lucy-ping [retry\|status]`. Tests in `hooks/*.test.ts` run with `claude plugin test ./mod`. |
| `bridge/` | Hono app deployable to Vercel. MCP Events server, its own single-owner OAuth 2.1 authorization server, and the `/ping` endpoint. Tests with `npm test`. |

## Proof levels

- **A — offline (this checkpoint).** `claude plugin validate ./mod`, `claude plugin test ./mod`, `cd bridge && npm test && npm run typecheck`. No network, no credentials.
- **B — connected.** Bridge deployed; ChatGPT completed OAuth and `events/subscribe` (callback verified); `/lucy-ping` reports `delivered` with a 2xx from ChatGPT's callback.
- **C — acknowledged.** Lucy posts the same event ID in her chat.

## Event ID guarantees

- The mod mints one UUID v4 per `/lucy-ping` and stores it before sending. While that event is undelivered,
  a plain `/lucy-ping` refuses to mint another; `/lucy-ping retry` resends **the same ID**.
- The bridge is idempotent on `eventId`: a retry re-delivers only what was not delivered, and every
  webhook attempt carries the same `webhook-id`/`eventId` with a fresh `webhook-timestamp` and signature,
  as the MCP Events draft requires. `410` retires the subscription; `413` is not retried.
- `delivered` means every active subscription got it. If only some did, the bridge answers `partial`,
  the mod keeps the event pending, and `/lucy-ping retry` reaches the rest with the same ID.
- Single-use credentials (consent request, authorization code, refresh token) are consumed atomically
  (`GETDEL` on Redis), so concurrent redemptions cannot both succeed.
- The verification challenge sent during `events/subscribe` is signed with the subscription secret and
  carries the subscription id, which is allocated before verification, as ChatGPT requires.

## Ownership and authentication

Two separate credentials, never shared:

1. **Mod → bridge**: `BRIDGE_PING_TOKEN`, stored in the mod's sensitive `userConfig` (secure storage, not settings.json).
2. **ChatGPT → bridge**: OAuth 2.1 as documented by OpenAI and MCP 2026-07-28: Protected Resource Metadata,
   Authorization Server Metadata, PKCE S256, `resource` indicator, `iss` in the redirect, Client ID Metadata
   Documents (ChatGPT's `https://chatgpt.com/oauth/client.json`, allow-listed) with Dynamic Client Registration
   as fallback (redirects limited to `chatgpt.com`). The consent page asks for `OWNER_PASSPHRASE`; every token
   is bound to `OWNER_SUBJECT`, and every subscription records that subject and the `client_id` that holds the
   token. Only that principal can refresh or remove it. `/ping` delivers only to that owner's subscriptions.

## Running the bridge locally

```bash
cd bridge
cp .env.example .env   # fill BRIDGE_PUBLIC_URL=http://localhost:8787, BRIDGE_PING_TOKEN, OWNER_PASSPHRASE
npm install
npm run dev            # in-memory store; ChatGPT cannot reach localhost, this is for curl-level checks only
```

## Deploying (checkpoint 2, not yet done)

Vercel project rooted at `bridge/`, Upstash Redis from the Vercel Marketplace, environment variables from
`.env.example`. Then in ChatGPT: Settings → Security and login → Developer mode; ChatGPT Plugins → + → the
bridge's `https://…/mcp` URL; approve on the consent page with the owner passphrase; install the plugin;
ask Lucy to subscribe to `lucy.ping` with the instruction to acknowledge the `eventId` in chat.

Load the mod for one session only, from this folder:

```bash
claude --plugin-dir ~/lucy-claude-mod/mod
```

The engine asks for `bridge_url` and `ping_token` on first load (`/config → lucy-ping`).

## Notes on the specs this follows

- MCP revision `2026-07-28`: stateless Streamable HTTP, per-request `_meta` (`io.modelcontextprotocol/protocolVersion`,
  `…/clientCapabilities`), `server/discover`, header mirroring (`MCP-Protocol-Version`, `Mcp-Method`) with
  `-32020`/`-32022` errors. `Mcp-Method` absence is tolerated unless `MCP_STRICT_HEADERS=1`.
- MCP Events draft as ChatGPT implements it: `events/*` methods, `events: {}` capability, webhook-only delivery,
  verification challenge, `refreshBefore`, `-32015 CallbackEndpointError`, https-only public callbacks.
- Standard Webhooks: `v1,base64(HMAC-SHA256(secret, "id.ts.body"))`, `whsec_` secrets of 24–64 bytes;
  cross-checked against the reference `standardwebhooks` package in tests.
