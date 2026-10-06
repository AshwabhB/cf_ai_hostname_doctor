// Constants shared by the Worker and the browser bundle.

// The browser always asks for this agent name. The router swaps in the visitor's sid.
export const AGENT_ALIAS = "me";

// WebSocket close code sent when the session cookie behind a socket has expired.
export const SESSION_EXPIRED_CLOSE = 4401;

// WebSocket close code sent when a visitor already has the most sockets allowed. The
// browser stops reconnecting and says there are too many open tabs.
export const TOO_MANY_SOCKETS_CLOSE = 4429;

// Error frame the agent sends on a socket. retry_after is in seconds, when known.
export type HdErrorFrame = {
  type: "hd_error";
  status: number;
  title: string;
  retry_after?: number;
};

export const SESSION_PATH = "/api/v1/session";

export const HEALTH_PATH = "/healthz";
