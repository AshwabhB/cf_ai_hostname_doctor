// Every limit, timeout, quota, page size, retry count and TTL lives here.
// Later stages add to this file instead of writing numbers inline.

const DAY_SECONDS = 24 * 60 * 60;

export const LIMITS = {
  chat: {
    // Upper bound on model steps in one turn. Each tool call plus its follow-up is a step.
    maxSteps: 5,
    // Messages kept in TenantAgent storage. Older ones are dropped by AIChatAgent.
    maxPersistedMessages: 100,
    // Longest user message accepted from the browser, in characters.
    maxUserMessageChars: 4000
  },
  session: {
    ttlSeconds: 30 * DAY_SECONDS,
    // The cookie is reissued when less than this much lifetime is left.
    renewWithinSeconds: 7 * DAY_SECONDS
  },
  http: {
    // Largest request body read on any route.
    maxBodyBytes: 16 * 1024
  },
  ws: {
    // Largest WebSocket frame accepted. Fits one user message at the max length.
    maxFrameBytes: 32 * 1024,
    // Per-connection token bucket for incoming frames.
    frameBurst: 20,
    frameRefillPerSecond: 2
  },
  // These mirror the ratelimits in wrangler.jsonc, which Wrangler needs as literals.
  // A unit test fails if the two drift apart.
  rateLimits: {
    sessionPerIp: { limit: 30, periodSeconds: 60 },
    connectPerVisitor: { limit: 30, periodSeconds: 60 }
  }
} as const;
