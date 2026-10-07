// HTTP boundary helpers: RFC 9457 problem responses, origin checks and body caps.

export type ProblemType =
  | "bad-request"
  | "invalid-hostname"
  | "invalid-cursor"
  | "unauthorized"
  | "forbidden"
  | "not-found"
  | "method-not-allowed"
  | "hostname-exists"
  | "quota-exceeded"
  | "invalid-transition"
  | "precondition-failed"
  | "payload-too-large"
  | "idempotency-key-reuse"
  | "precondition-required"
  | "rate-limited";

const TITLES: Record<ProblemType, string> = {
  "bad-request": "Bad request",
  "invalid-hostname": "Invalid hostname",
  "invalid-cursor": "Invalid cursor",
  unauthorized: "Session missing or invalid",
  forbidden: "Forbidden",
  "not-found": "Not found",
  "method-not-allowed": "Method not allowed",
  "hostname-exists": "Hostname already added",
  "quota-exceeded": "Hostname limit reached",
  "invalid-transition": "Not allowed in the current state",
  "precondition-failed": "The hostname changed since you last read it",
  "payload-too-large": "Payload too large",
  "idempotency-key-reuse":
    "Idempotency key already used for a different request",
  "precondition-required": "Required header missing",
  "rate-limited": "Too many requests"
};

const STATUS: Record<ProblemType, number> = {
  "bad-request": 400,
  "invalid-hostname": 400,
  "invalid-cursor": 400,
  unauthorized: 401,
  forbidden: 403,
  "not-found": 404,
  "method-not-allowed": 405,
  "hostname-exists": 409,
  "quota-exceeded": 409,
  "invalid-transition": 409,
  "precondition-failed": 412,
  "payload-too-large": 413,
  "idempotency-key-reuse": 422,
  "precondition-required": 428,
  "rate-limited": 429
};

export const NO_STORE = "no-store";
export const NO_TRANSFORM = "no-transform";

// Detail strings are fixed per call site and never carry exception text.
export function problem(
  type: ProblemType,
  request: Request,
  detail?: string
): Response {
  const body = {
    type: `/problems/${type}`,
    title: TITLES[type],
    status: STATUS[type],
    ...(detail ? { detail } : {}),
    instance: new URL(request.url).pathname
  };
  return new Response(JSON.stringify(body), {
    status: STATUS[type],
    headers: {
      "content-type": "application/problem+json",
      "cache-control": NO_STORE,
      "x-content-type-options": "nosniff"
    }
  });
}

export function allowedOrigins(env: { ALLOWED_ORIGINS: string }): Set<string> {
  return new Set(
    env.ALLOWED_ORIGINS.split(",")
      .map((o) => o.trim())
      .filter(Boolean)
  );
}

// Exact match only. A missing Origin header is treated as not allowed.
export function isAllowedOrigin(
  request: Request,
  env: { ALLOWED_ORIGINS: string }
): boolean {
  const origin = request.headers.get("origin");
  return origin !== null && allowedOrigins(env).has(origin);
}

export function isWebSocketUpgrade(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

export class BodyTooLargeError extends Error {}

// Reads at most maxBytes of the body. Throws BodyTooLargeError past the cap,
// whether or not Content-Length was honest.
export async function readBodyCapped(
  request: Request,
  maxBytes: number
): Promise<string> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new BodyTooLargeError();
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    joined.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(joined);
}
