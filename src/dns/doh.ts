// DNS over HTTPS client. The only outbound fetch in the server code, which a test enforces.
// It talks to one fixed resolver. Callers build every name from a normalized hostname
// (see diagnose.ts), and the client refuses anything that is not a plain DNS name.
import { z } from "zod";
import { LIMITS } from "../config/limits";

export const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";

export type RecordType = "TXT" | "CNAME" | "CAA";
export const RR_TYPE: Record<RecordType, number> = {
  TXT: 16,
  CNAME: 5,
  CAA: 257
};

export type DohAnswer = {
  name: string;
  type: number;
  TTL: number;
  data: string;
};

export type LookupResult =
  | { status: "ok"; answers: DohAnswer[] }
  | { status: "nxdomain" }
  | { status: "servfail" }
  | { status: "timeout" }
  | {
      status: "error";
      reason: "too_large" | "bad_response" | "http" | "budget" | "bad_name";
    };

const DohResponse = z.object({
  Status: z.number().int(),
  Answer: z
    .array(
      z.object({
        name: z.string().max(300),
        type: z.number().int(),
        TTL: z.number().int().nonnegative(),
        data: z.string().max(LIMITS.dns.maxResponseBytes)
      })
    )
    .optional(),
  Authority: z
    .array(z.object({ TTL: z.number().int().nonnegative() }))
    .optional()
});

export interface DnsCache {
  get(name: string, type: RecordType, nowMs: number): LookupResult | null;
  set(
    name: string,
    type: RecordType,
    result: LookupResult,
    expiresAtMs: number,
    nowMs: number
  ): void;
}

export type DohDeps = {
  fetch: typeof fetch;
  cache: DnsCache;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  timeoutMs: number;
};

export const defaultDohDeps = (cache: DnsCache): DohDeps => ({
  fetch: (input, init) => fetch(input, init),
  cache,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
  timeoutMs: LIMITS.dns.timeoutMs
});

class TimeoutError extends Error {}
class TooLargeError extends Error {}
class RetryableError extends Error {}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new TooLargeError();
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new TooLargeError();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(out);
}

// One lookup budget per diagnosis.
export class DohClient {
  private used = 0;

  constructor(private readonly deps: DohDeps) {}

  get lookupsUsed(): number {
    return this.used;
  }

  async lookup(name: string, type: RecordType): Promise<LookupResult> {
    if (!isQuerySafe(name)) return { status: "error", reason: "bad_name" };
    if (this.used >= LIMITS.dns.maxLookupsPerDiagnosis) {
      return { status: "error", reason: "budget" };
    }
    this.used++;

    const now = this.deps.now();
    const cached = this.deps.cache.get(name, type, now);
    if (cached) return cached;

    const result = await this.resolve(name, type);
    const ttl = cacheSeconds(result);
    if (ttl > 0)
      this.deps.cache.set(name, type, result.value, now + ttl * 1000, now);
    return result.value;
  }

  private async resolve(
    name: string,
    type: RecordType
  ): Promise<{ value: LookupResult; ttlHint: number | null }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) {
        const { retryJitterMinMs: min, retryJitterMaxMs: max } = LIMITS.dns;
        await this.deps.sleep(
          min + Math.floor(this.deps.random() * (max - min + 1))
        );
      }
      try {
        return await this.once(name, type);
      } catch (e) {
        if (e instanceof TimeoutError)
          return { value: { status: "timeout" }, ttlHint: null };
        if (e instanceof TooLargeError) {
          return {
            value: { status: "error", reason: "too_large" },
            ttlHint: null
          };
        }
        // Anything else is a network failure or a 5xx, which gets the one retry.
      }
    }
    return { value: { status: "error", reason: "http" }, ttlHint: null };
  }

  private async once(
    name: string,
    type: RecordType
  ): Promise<{ value: LookupResult; ttlHint: number | null }> {
    const url = new URL(DOH_ENDPOINT);
    url.searchParams.set("name", name);
    url.searchParams.set("type", type);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.deps.timeoutMs);
    let res: Response;
    let text: string;
    try {
      res = await this.deps.fetch(url.toString(), {
        headers: { accept: "application/dns-json" },
        signal: controller.signal
      });
      if (res.status >= 500) throw new RetryableError();
      if (!res.ok)
        return { value: { status: "error", reason: "http" }, ttlHint: null };
      text = await readCapped(res, LIMITS.dns.maxResponseBytes);
    } catch (e) {
      if (controller.signal.aborted) throw new TimeoutError();
      if (e instanceof TooLargeError) throw e;
      throw e instanceof RetryableError ? e : new RetryableError();
    } finally {
      clearTimeout(timer);
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return {
        value: { status: "error", reason: "bad_response" },
        ttlHint: null
      };
    }
    const parsed = DohResponse.safeParse(json);
    if (!parsed.success)
      return {
        value: { status: "error", reason: "bad_response" },
        ttlHint: null
      };
    const body = parsed.data;
    if (body.Status === 3)
      return {
        value: { status: "nxdomain" },
        ttlHint: body.Authority?.[0]?.TTL ?? null
      };
    if (body.Status !== 0)
      return { value: { status: "servfail" }, ttlHint: null };
    const answers = body.Answer ?? [];
    const ttlHint = answers.length
      ? Math.min(...answers.map((a) => a.TTL))
      : (body.Authority?.[0]?.TTL ?? null);
    return { value: { status: "ok", answers }, ttlHint };
  }
}

// How long to cache a result: min(TTL, 60 s), SERVFAIL at most 10 s, failures never.
export function cacheSeconds(result: {
  value: LookupResult;
  ttlHint: number | null;
}): number {
  const { cacheMaxTtlSeconds, servfailCacheMaxSeconds } = LIMITS.dns;
  switch (result.value.status) {
    case "ok":
    case "nxdomain":
      return Math.min(result.ttlHint ?? cacheMaxTtlSeconds, cacheMaxTtlSeconds);
    case "servfail":
      return servfailCacheMaxSeconds;
    default:
      return 0;
  }
}

// Plain lowercase DNS names only: LDH labels of 1 to 63 characters, 253 in total, with an
// optional leading "_cf-custom-hostname" label. CAA parents like "co.uk" or "com" pass this
// even though normalization refuses them as hostnames, which is why it is a separate check.
export function isQuerySafe(name: string): boolean {
  if (name.length === 0 || name.length > 253) return false;
  const labels = name.split(".");
  if (labels[0] === "_cf-custom-hostname") labels.shift();
  return (
    labels.length > 0 &&
    labels.every((l) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l))
  );
}
