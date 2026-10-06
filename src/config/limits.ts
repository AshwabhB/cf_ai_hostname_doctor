// Every limit, timeout, quota, page size, retry count and TTL lives here.
// Later stages add to this file instead of writing numbers inline.

export const LIMITS = {
  chat: {
    // Upper bound on model steps in one turn. Each tool call plus its follow-up is a step.
    maxSteps: 5,
    // Messages kept in TenantAgent storage. Older ones are dropped by AIChatAgent.
    maxPersistedMessages: 100
  }
} as const;
