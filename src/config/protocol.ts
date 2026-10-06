// Constants shared by the Worker and the browser bundle.

// The browser always asks for this agent name. The router swaps in the visitor's sid.
export const AGENT_ALIAS = "me";

// WebSocket close code sent when the session cookie behind a socket has expired.
export const SESSION_EXPIRED_CLOSE = 4401;

export const SESSION_PATH = "/api/v1/session";
