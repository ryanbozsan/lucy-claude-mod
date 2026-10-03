/** The event catalogue: one event, no filters. */
export const LUCY_PING = 'lucy.ping'

export const EVENT_DEFINITIONS = [
  {
    name: LUCY_PING,
    description:
      "Claude rang Lucy's doorbell: a harmless test greeting sent manually from Claude Code. Acknowledge it by repeating the eventId in this chat.",
    delivery: ['webhook'],
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    payloadSchema: {
      type: 'object',
      properties: {
        eventId: { type: 'string', description: 'Unique ID of this ring; repeat it in your acknowledgement.' },
        greeting: { type: 'string' },
        sentAt: { type: 'string', description: 'ISO-8601 time Claude sent the ring.' },
        source: { type: 'string' },
      },
      required: ['eventId', 'greeting', 'sentAt', 'source'],
      additionalProperties: false,
    },
  },
] as const

export type Subscription = {
  id: string
  owner: string
  clientId: string
  name: string
  arguments: Record<string, unknown>
  url: string
  secret: string
  createdAt: string
  refreshedAt: string
  refreshBefore: string
  cursor: null
  /** Set when the receiver answered 410 Gone; no further deliveries. */
  deadAt?: string
}

export const subKey = (id: string): string => `sub:${id}`
export const SUB_PREFIX = 'sub:'
