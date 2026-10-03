export type Config = {
  /** Public https origin of the bridge, no trailing slash, e.g. https://lucy-bridge.vercel.app */
  publicUrl: string
  /** Bearer token the lucy-ping mod presents on /ping. */
  pingToken: string
  /** Passphrase the owner types on the OAuth consent page. */
  ownerPassphrase: string
  /** Stable principal id every token and subscription is bound to. */
  ownerSubject: string
  /** CIMD client_id URLs allowed to obtain tokens. */
  allowedClientIdPatterns: RegExp[]
  /** Hosts a redirect_uri may point at (exact match). */
  allowedRedirectHosts: string[]
  /** Hosts a webhook callback may point at (exact match); empty means any public host. */
  allowedCallbackHosts: string[]
  subscriptionTtlMs: number
  maxSubscriptionTtlMs: number
  accessTokenTtlSeconds: number
  refreshTokenTtlSeconds: number
  authCodeTtlSeconds: number
  verificationTimeoutMs: number
  deliveryTimeoutMs: number
  deliveryAttempts: number
  /** Reject a POST /mcp lacking the Mcp-Method mirror header. The spec says MUST; off by default for interop. */
  strictMcpHeaders: boolean
}

/** ChatGPT's documented Client ID Metadata Document URLs. */
export const CHATGPT_CLIENT_ID_PATTERNS = [
  /^https:\/\/chatgpt\.com\/oauth\/client\.json$/,
  /^https:\/\/chatgpt\.com\/oauth\/[A-Za-z0-9_-]+\/client\.json$/,
]

export const DEFAULTS = {
  ownerSubject: 'owner',
  allowedRedirectHosts: ['chatgpt.com'],
  allowedCallbackHosts: [] as string[],
  subscriptionTtlMs: 7 * 24 * 60 * 60 * 1000,
  maxSubscriptionTtlMs: 30 * 24 * 60 * 60 * 1000,
  accessTokenTtlSeconds: 60 * 60,
  refreshTokenTtlSeconds: 30 * 24 * 60 * 60,
  authCodeTtlSeconds: 10 * 60,
  verificationTimeoutMs: 5000,
  deliveryTimeoutMs: 8000,
  deliveryAttempts: 3,
  strictMcpHeaders: false,
}

export function configFromEnv(env: Record<string, string | undefined>): Config {
  const need = (k: string): string => {
    const v = env[k]?.trim()
    if (!v) throw new Error(`missing required environment variable ${k}`)
    return v
  }
  const publicUrl = need('BRIDGE_PUBLIC_URL').replace(/\/+$/, '')
  if (!/^https:\/\/[^/]+$/.test(publicUrl) && !/^http:\/\/localhost(:\d+)?$/.test(publicUrl)) {
    throw new Error('BRIDGE_PUBLIC_URL must be an https origin without a path (http://localhost allowed for dev)')
  }
  const list = (k: string, d: string[]): string[] => env[k]?.split(',').map(s => s.trim()).filter(Boolean) ?? d
  return {
    publicUrl,
    pingToken: need('BRIDGE_PING_TOKEN'),
    ownerPassphrase: need('OWNER_PASSPHRASE'),
    ownerSubject: env.OWNER_SUBJECT?.trim() || DEFAULTS.ownerSubject,
    allowedClientIdPatterns: env.ALLOWED_CLIENT_ID_PATTERNS
      ? list('ALLOWED_CLIENT_ID_PATTERNS', []).map(p => new RegExp(p))
      : CHATGPT_CLIENT_ID_PATTERNS,
    allowedRedirectHosts: list('ALLOWED_REDIRECT_HOSTS', DEFAULTS.allowedRedirectHosts),
    allowedCallbackHosts: list('ALLOWED_CALLBACK_HOSTS', DEFAULTS.allowedCallbackHosts),
    subscriptionTtlMs: Number(env.SUBSCRIPTION_TTL_MS ?? DEFAULTS.subscriptionTtlMs),
    maxSubscriptionTtlMs: Number(env.MAX_SUBSCRIPTION_TTL_MS ?? DEFAULTS.maxSubscriptionTtlMs),
    accessTokenTtlSeconds: Number(env.ACCESS_TOKEN_TTL_SECONDS ?? DEFAULTS.accessTokenTtlSeconds),
    refreshTokenTtlSeconds: Number(env.REFRESH_TOKEN_TTL_SECONDS ?? DEFAULTS.refreshTokenTtlSeconds),
    authCodeTtlSeconds: DEFAULTS.authCodeTtlSeconds,
    verificationTimeoutMs: DEFAULTS.verificationTimeoutMs,
    deliveryTimeoutMs: DEFAULTS.deliveryTimeoutMs,
    deliveryAttempts: DEFAULTS.deliveryAttempts,
    strictMcpHeaders: env.MCP_STRICT_HEADERS === '1',
  }
}

/** The canonical resource identifier tokens are issued for (RFC 8707). */
export const mcpResource = (cfg: Config): string => `${cfg.publicUrl}/mcp`
