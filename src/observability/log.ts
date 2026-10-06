// Structured JSON logs. Every line goes through redact(), which keeps only allowlisted
// keys and masks anything shaped like a secret. Callers never pass prompts, model text,
// cookies, tokens or TXT values; the masks are a second line of defence.
import { AsyncLocalStorage } from "node:async_hooks";
import { LIMITS } from "../config/limits";
import type { Diagnosis } from "../dns/diagnose";

export type LogEvent =
  | "transition"
  | "tool_call"
  | "workflow_step"
  | "dns_check"
  | "model_call"
  | "api_request";

type Scalar = string | number | boolean | null;
export type LogFields = Record<string, unknown>;
export type LogContext = { visitor?: string; correlation_id?: string };

// Keys a log line may carry. Anything else is dropped.
const ALLOWED_KEYS = new Set([
  "event",
  "visitor",
  "hostname_id",
  "outcome",
  "latency_ms",
  "correlation_id",
  // transitions
  "from_state",
  "to_state",
  "actor",
  // tools, workflow steps and model calls
  "tool",
  "step",
  "attempt",
  "steps",
  "first_token_ms",
  "error",
  // DNS checks
  "lookups",
  "findings",
  // API requests
  "method",
  "route",
  "status"
]);

const MASK = "[redacted]";
// A 32+ hex run covers session ids, TXT tokens and HMACs. Hostname ids (hn_ + 24 hex)
// stay readable.
const LONG_HEX = /[0-9a-f]{32,}/gi;
// Long base64 or base64url runs: signed cookies, bearer tokens, API keys.
const LONG_OPAQUE = /[A-Za-z0-9+/_-]{40,}={0,2}/g;
// A value that names a credential is dropped whole.
const CREDENTIAL = /cookie|bearer|authorization|password|secret|token\s*[:=]/i;

function maskString(value: string): string {
  if (CREDENTIAL.test(value)) return MASK;
  const masked = value.replace(LONG_HEX, MASK).replace(LONG_OPAQUE, MASK);
  return masked.length > LIMITS.logs.maxStringChars
    ? masked.slice(0, LIMITS.logs.maxStringChars)
    : masked;
}

function cleanValue(value: unknown): Scalar | string[] | undefined {
  if (value === null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return maskString(value);
  if (Array.isArray(value)) {
    return value
      .filter((v): v is string => typeof v === "string")
      .slice(0, LIMITS.logs.maxListItems)
      .map(maskString);
  }
  // Objects, errors and anything else never reach a log line.
  return undefined;
}

export function redact(fields: LogFields): Record<string, Scalar | string[]> {
  const out: Record<string, Scalar | string[]> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!ALLOWED_KEYS.has(key)) continue;
    const clean = cleanValue(value);
    if (clean !== undefined) out[key] = clean;
  }
  return out;
}

const context = new AsyncLocalStorage<LogContext>();

// Runs fn with a visitor and correlation id that every log line inside picks up.
export function withLogContext<T>(ctx: LogContext, fn: () => T): T {
  return context.run({ ...context.getStore(), ...ctx }, fn);
}

// Adds fields to the current context, for values learned partway through, such as the
// visitor once the session cookie has been read.
export function annotateLogContext(ctx: LogContext): void {
  const store = context.getStore();
  if (store) Object.assign(store, ctx);
}

export function currentLogContext(): LogContext {
  return context.getStore() ?? {};
}

export function log(event: LogEvent, fields: LogFields = {}): void {
  console.log(
    JSON.stringify(redact({ ...currentLogContext(), ...fields, event }))
  );
}

export function elapsedMs(startMs: number): number {
  return Math.max(0, Date.now() - startMs);
}

// A short keyed hash of the session id, so log lines can be grouped per visitor without
// the id itself, which is the Durable Object name and part of the signed cookie.
const keys = new Map<string, Promise<CryptoKey>>();

export async function visitorHash(
  secret: string,
  sid: string
): Promise<string> {
  let key = keys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    keys.set(secret, key);
  }
  const mac = await crypto.subtle.sign(
    "HMAC",
    await key,
    new TextEncoder().encode(`log-visitor:${sid}`)
  );
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, LIMITS.logs.visitorHashChars);
}

// The loggable part of a DNS diagnosis: outcome, lookup count and finding codes. Observed
// records, which can hold TXT values, are never included.
export function dnsCheckFields(diagnosis: Diagnosis): LogFields {
  const codes = diagnosis.findings.map((f) => f.code);
  return {
    outcome: codes.includes("DNS_ERROR")
      ? "dns_error"
      : diagnosis.verifiable
        ? "verifiable"
        : "not_verifiable",
    lookups: diagnosis.lookups,
    findings: codes
  };
}
