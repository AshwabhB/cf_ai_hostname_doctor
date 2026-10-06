// Visitor sessions: a random id in an HMAC-SHA256 signed cookie.
// Nothing personal is stored. The cookie holds only a version, the id and two timestamps.
import { z } from "zod";
import { LIMITS } from "../config/limits";

const COOKIE_BASE = "hd_sid";
const VERSION = 1;

const PayloadSchema = z
  .object({
    v: z.literal(VERSION),
    sid: z.string().regex(/^[0-9a-f]{32}$/),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive()
  })
  .strict();

export type SessionPayload = z.infer<typeof PayloadSchema>;

export type SessionResult =
  | { ok: true; payload: SessionPayload }
  | {
      ok: false;
      reason: "missing" | "malformed" | "bad_signature" | "expired";
    };

export type SessionEnv = { SESSION_SECRET: string; COOKIE_DEV_MODE?: string };

export function isDevMode(env: SessionEnv): boolean {
  return env.COOKIE_DEV_MODE === "true";
}

// The __Host- prefix needs Secure, Path=/ and no Domain. Dev mode drops only the prefix.
export function cookieName(env: SessionEnv): string {
  return isDevMode(env) ? COOKIE_BASE : `__Host-${COOKIE_BASE}`;
}

const encoder = new TextEncoder();

// workerd adds timingSafeEqual to SubtleCrypto. The DOM lib in tsconfig (for the
// React client) types crypto.subtle without it, so it is typed here.
const subtle = crypto.subtle as SubtleCrypto & {
  timingSafeEqual(a: ArrayBufferView, b: ArrayBufferView): boolean;
};

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    // Only the canonical encoding is accepted, so each token has exactly one spelling.
    return toBase64Url(bytes) === text ? bytes : null;
  } catch {
    return null;
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  if (secret.length < LIMITS.session.minSecretChars)
    throw new Error("SESSION_SECRET is too short");
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

async function sign(data: string, secret: string): Promise<Uint8Array> {
  const key = await hmacKey(secret);
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(data))
  );
}

export async function encodeSession(
  payload: SessionPayload,
  secret: string
): Promise<string> {
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  return `${body}.${toBase64Url(await sign(body, secret))}`;
}

export async function decodeSession(
  token: string | null,
  secret: string,
  nowSeconds: number
): Promise<SessionResult> {
  if (!token) return { ok: false, reason: "missing" };
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const [body, sig] = parts;
  const given = fromBase64Url(sig);
  const bodyBytes = fromBase64Url(body);
  if (!given || !bodyBytes) return { ok: false, reason: "malformed" };

  const expected = await sign(body, secret);
  if (
    given.byteLength !== expected.byteLength ||
    !subtle.timingSafeEqual(given, expected)
  ) {
    return { ok: false, reason: "bad_signature" };
  }

  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bodyBytes));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const parsed = PayloadSchema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: "malformed" };
  if (parsed.data.exp <= nowSeconds) return { ok: false, reason: "expired" };
  return { ok: true, payload: parsed.data };
}

export function newSession(nowSeconds: number): SessionPayload {
  const bytes = crypto.getRandomValues(new Uint8Array(LIMITS.session.sidBytes));
  const sid = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    ""
  );
  return {
    v: VERSION,
    sid,
    iat: nowSeconds,
    exp: nowSeconds + LIMITS.session.ttlSeconds
  };
}

export function renewed(
  payload: SessionPayload,
  nowSeconds: number
): SessionPayload {
  return {
    ...payload,
    iat: nowSeconds,
    exp: nowSeconds + LIMITS.session.ttlSeconds
  };
}

export function needsRenewal(
  payload: SessionPayload,
  nowSeconds: number
): boolean {
  return payload.exp - nowSeconds < LIMITS.session.renewWithinSeconds;
}

// Returns the value of our cookie, or null when it is absent or sent more than once.
export function readCookie(request: Request, env: SessionEnv): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  const name = cookieName(env);
  const values = header
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => pair.startsWith(`${name}=`))
    .map((pair) => pair.slice(name.length + 1));
  return values.length === 1 ? values[0] : null;
}

export function setCookieHeader(
  token: string,
  payload: SessionPayload,
  env: SessionEnv,
  nowSeconds: number
): string {
  const maxAge = Math.max(0, payload.exp - nowSeconds);
  return `${cookieName(env)}=${token}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`;
}

export function readSession(
  request: Request,
  env: SessionEnv,
  nowSeconds: number
): Promise<SessionResult> {
  return decodeSession(
    readCookie(request, env),
    env.SESSION_SECRET,
    nowSeconds
  );
}
