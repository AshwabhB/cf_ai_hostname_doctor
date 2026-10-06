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
    maxUserMessageChars: 4000,
    temperature: 0.2,
    maxOutputTokens: 1024,
    // The model's real context window (Workers AI model page). Budgets below fit well inside.
    contextWindowTokens: 24_000,
    systemPromptMaxTokens: 600,
    stateMaxTokens: 1500,
    historyMessages: 12,
    historyMaxTokens: 6000,
    // No Llama tokenizer runs in the Worker, so token counts are estimated conservatively.
    charsPerToken: 3,
    firstTokenMs: 10_000,
    totalMs: 30_000,
    // One retry before the first token on a 5xx or timeout.
    retriesBeforeFirstToken: 1,
    // The second invalid tool call in a turn ends it with a fixed message.
    maxInvalidToolCalls: 2,
    // One turn per visitor. The lease expires on its own only as a backstop.
    leaseMs: 60_000,
    // explain_findings runs a fresh DNS check when the saved one is older than this.
    findingsFreshMs: 5 * 60 * 1000,
    // Model turns per visitor per UTC day, shared by all of the visitor's sockets.
    turnsPerVisitorPerDay: 30,
    // Longest hostname a tool accepts from the model, before normalization.
    toolHostnameMaxChars: 300,
    // Hostnames listed in the summary written when the step cap ends a turn.
    stepCapSummaryRows: 10
  },
  session: {
    ttlSeconds: 30 * DAY_SECONDS,
    // The cookie is reissued when less than this much lifetime is left.
    renewWithinSeconds: 7 * DAY_SECONDS,
    // Random bytes in a session id (128 bits).
    sidBytes: 16,
    // Shortest SESSION_SECRET accepted for signing cookies.
    minSecretChars: 32
  },
  hostnames: {
    // Live (not deleted) hostnames one visitor may hold.
    maxPerVisitor: 25,
    // Raw input longer than this is rejected before any IDNA work.
    maxInputChars: 1024,
    // Random bytes in a TXT verification token (128 bits).
    verifyTokenBytes: 16
  },
  idempotency: {
    ttlSeconds: 24 * 60 * 60,
    // Per visitor. The oldest keys are evicted past this.
    maxRows: 500,
    maxKeyChars: 128
  },
  paging: {
    defaultLimit: 20,
    maxLimit: 50,
    // Longest cursor accepted back from a client.
    maxCursorChars: 200
  },
  dns: {
    timeoutMs: 3000,
    // Retries per lookup, on a network error or 5xx only.
    retries: 1,
    // Longest name accepted in a DoH answer.
    maxAnswerNameChars: 300,
    // One retry on a network error or 5xx, after a random pause in this range.
    retryJitterMinMs: 200,
    retryJitterMaxMs: 500,
    maxResponseBytes: 64 * 1024,
    maxLookupsPerDiagnosis: 12,
    cnameMaxHops: 3,
    cacheMaxTtlSeconds: 60,
    servfailCacheMaxSeconds: 10,
    // Applied to attacker-controlled DNS text before it is stored or shown.
    maxStringChars: 255,
    maxRecordsPerName: 10
  },
  verify: {
    // Sleeps between DNS attempts: these first, then steadyBackoffSeconds.
    backoffSeconds: [30, 60, 120, 300],
    steadyBackoffSeconds: 600,
    // Stop once the sleeps add up to this. Counted in attempts, not wall-clock time, so
    // replays and skipped sleeps behave the same. 24 h is 149 attempts and 148 sleeps.
    giveUpAfterSeconds: 24 * 60 * 60,
    // Workflows allow 1,024 steps per instance on Free (10,000 default on Paid).
    // A test keeps the worst case under half of the Free limit.
    stepLimitFloor: 1024,
    // A healthy run records an attempt at least every steadyBackoffSeconds, plus the time
    // one DNS attempt takes. A pending row with no attempt and no run start for this long
    // has a stalled instance, whatever status the engine reports for it.
    stalledAfterMs: 15 * 60 * 1000,
    // A row stuck in deleting this long is finished by reconcile.
    deletingStuckMs: 2 * 60 * 1000,
    reconcileEverySeconds: 600,
    // Simulated certificates. Nothing is issued by a real CA.
    certificateDays: 90
  },
  checks: {
    // Manual DNS checks per visitor, counted in TenantAgent over a sliding hour.
    perVisitorPerHour: 30
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
    frameRefillPerSecond: 2,
    // Open sockets per visitor. One more is accepted, then closed with 4429.
    maxSocketsPerVisitor: 3,
    // Frame schema caps: message and RPC ids, the ETag a callable takes, parts in one
    // user message, and RPC method names.
    maxIdChars: 64,
    maxEtagChars: 128,
    maxMessageParts: 8,
    maxMethodChars: 64
  },
  ui: {
    // How often the chat re-renders while a reply streams.
    chatThrottleMs: 100,
    // How long a copy button shows its check mark.
    copiedFeedbackMs: 1500
  },
  logs: {
    // Longest string value a log line keeps. Longer values are cut.
    maxStringChars: 120,
    // Most items kept from a list value, such as finding codes.
    maxListItems: 10,
    // Hex characters kept from the visitor's HMAC, enough to tell visitors apart.
    visitorHashChars: 16
  },
  // These mirror the ratelimits in wrangler.jsonc, which Wrangler needs as literals.
  // A unit test fails if the two drift apart.
  rateLimits: {
    sessionPerIp: { limit: 30, periodSeconds: 60 },
    connectPerVisitor: { limit: 30, periodSeconds: 60 },
    apiPerVisitor: { limit: 60, periodSeconds: 60 }
  }
} as const;
