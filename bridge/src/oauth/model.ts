export type Principal = { subject: string; clientId: string; scope: string; resource: string }

export type RegisteredClient = {
  client_id: string
  client_name?: string
  redirect_uris: string[]
  token_endpoint_auth_method: 'none'
  grant_types: string[]
  response_types: string[]
  /** 'cimd' when the client_id is an https URL whose document was fetched; 'dcr' when registered here. */
  source: 'cimd' | 'dcr'
}

export type AuthRequest = {
  id: string
  clientId: string
  clientName: string
  redirectUri: string
  codeChallenge: string
  state?: string
  scope: string
  resource: string
  createdAt: string
}

export type AuthCode = {
  clientId: string
  redirectUri: string
  codeChallenge: string
  scope: string
  resource: string
  subject: string
  issuedAt: string
}

export type TokenRow = {
  kind: 'access' | 'refresh'
  subject: string
  clientId: string
  scope: string
  resource: string
  issuedAt: string
  expiresAt: string
  /** refresh rows: the family id, so a reused refresh token can revoke its family. */
  family?: string
}

export const SCOPE_EVENTS = 'events'
export const keys = {
  client: (id: string) => `client:${id}`,
  cimd: (url: string) => `cimd:${url}`,
  authreq: (id: string) => `authreq:${id}`,
  code: (hash: string) => `code:${hash}`,
  token: (hash: string) => `token:${hash}`,
}
