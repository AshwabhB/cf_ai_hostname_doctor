import { SELF, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIMITS } from "../src/config/limits";
import {
  CONTENT_SECURITY_POLICY,
  SECURITY_HEADERS,
  headersFile
} from "../src/config/security-headers";
import { decodeSession, readCookie } from "../src/security/session";
import wranglerConfig from "../wrangler.jsonc?raw";
import {
  BASE,
  ORIGIN,
  nowSeconds,
  spyOnModel,
  upgrade,
  visitor
} from "./helpers";

afterEach(() => vi.restoreAllMocks());

const session = (headers: HeadersInit = {}) =>
  SELF.fetch(`${BASE}/api/v1/session`, { headers });

async function expectProblem(res: Response, status: number) {
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type")).toBe("application/problem+json");
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("access-control-allow-origin")).toBeNull();
  const body = (await res.json()) as Record<string, unknown>;
  // Only the RFC 9457 members we set. No stack, no exception text.
  expect(Object.keys(body).sort()).toEqual(
    expect.arrayContaining(["instance", "status", "title", "type"])
  );
  for (const key of Object.keys(body)) {
    expect(["type", "title", "status", "detail", "instance"]).toContain(key);
  }
  expect(body.status).toBe(status);
}

function sessionFrom(res: Response) {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) return null;
  const req = new Request(BASE, {
    headers: { cookie: setCookie.split(";")[0] }
  });
  return decodeSession(readCookie(req, env), env.SESSION_SECRET, nowSeconds());
}

describe("GET /api/v1/session", () => {
  it("creates a session when there is none", async () => {
    const res = await session({ "cf-connecting-ip": "10.0.0.1" });
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const decoded = await sessionFrom(res);
    expect(decoded?.ok).toBe(true);
  });

  it("leaves a fresh session alone", async () => {
    const v = await visitor();
    const res = await session({
      cookie: v.cookie,
      "cf-connecting-ip": "10.0.0.2"
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("renews a session with less than a week left and keeps the sid", async () => {
    const now = nowSeconds();
    const v = await visitor({ exp: now + 60 });
    const res = await session({
      cookie: v.cookie,
      "cf-connecting-ip": "10.0.0.3"
    });
    const decoded = await sessionFrom(res);
    expect(decoded?.ok && decoded.payload.sid).toBe(v.payload.sid);
    expect(decoded?.ok && decoded.payload.exp).toBeGreaterThan(now + 60);
  });

  it("replaces a tampered cookie with a new identity", async () => {
    const v = await visitor();
    const res = await session({
      cookie: v.cookie + "x",
      "cf-connecting-ip": "10.0.0.4"
    });
    const decoded = await sessionFrom(res);
    expect(decoded?.ok).toBe(true);
    expect(decoded?.ok && decoded.payload.sid).not.toBe(v.payload.sid);
  });

  it("refuses non-GET methods", async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/session`, {
      method: "POST",
      headers: { origin: ORIGIN }
    });
    await expectProblem(res, 405);
  });

  it("rate limits session creation per IP with 429", async () => {
    const ip = "10.9.9.9";
    const statuses: number[] = [];
    for (let i = 0; i <= LIMITS.rateLimits.sessionPerIp.limit; i++) {
      statuses.push((await session({ "cf-connecting-ip": ip })).status);
    }
    expect(statuses.slice(0, -1).every((s) => s === 204)).toBe(true);
    await expectProblem(await session({ "cf-connecting-ip": ip }), 429);
  });
});

describe("origin and CORS", () => {
  it("rejects non-GET from a foreign origin before anything else", async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/session`, {
      method: "POST",
      headers: { origin: "https://evil.example" }
    });
    await expectProblem(res, 403);
  });

  it("rejects non-GET with no Origin header", async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/session`, {
      method: "DELETE"
    });
    await expectProblem(res, 403);
  });

  it("answers preflight with 403 and no CORS headers", async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/session`, {
      method: "OPTIONS",
      headers: { origin: ORIGIN, "access-control-request-method": "POST" }
    });
    await expectProblem(res, 403);
  });

  it("returns 413 when the declared body is over the cap", async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/session`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: "x".repeat(LIMITS.http.maxBodyBytes + 1)
    });
    await expectProblem(res, 413);
  });
});

describe("agent routes", () => {
  const messages = (name: string, cookie?: string) =>
    SELF.fetch(`${BASE}/agents/tenant-agent/${name}/get-messages`, {
      headers: cookie ? { cookie } : {}
    });

  it("returns 401 with no cookie", async () => {
    await expectProblem(await messages("me"), 401);
  });

  it("returns 401 for a tampered cookie", async () => {
    const v = await visitor();
    await expectProblem(
      await messages("me", v.cookie.slice(0, -2) + "AA"),
      401
    );
  });

  it("returns 401 for an expired cookie", async () => {
    const v = await visitor({ exp: nowSeconds() - 1 });
    await expectProblem(await messages("me", v.cookie), 401);
  });

  it("serves the visitor's own history with no-store", async () => {
    const v = await visitor();
    const res = await messages("me", v.cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual([]);
  });

  it("returns 403 for another visitor's agent", async () => {
    const alice = await visitor();
    const bob = await visitor();
    await expectProblem(await messages(bob.payload.sid, alice.cookie), 403);
  });

  it("returns 403 for any other agent name", async () => {
    const v = await visitor();
    await expectProblem(await messages("default", v.cookie), 403);
  });

  it("never routes to the hostname registry", async () => {
    const v = await visitor();
    const res = await SELF.fetch(`${BASE}/agents/hostname-registry/me`, {
      headers: { cookie: v.cookie }
    });
    await expectProblem(res, 403);
  });

  it("returns 404 for other agent sub-paths", async () => {
    const v = await visitor();
    const res = await SELF.fetch(`${BASE}/agents/tenant-agent/me/callback`, {
      headers: { cookie: v.cookie }
    });
    await expectProblem(res, 404);
  });

  it("returns 404 problem JSON for unknown paths", async () => {
    await expectProblem(await SELF.fetch(`${BASE}/nope`), 404);
  });
});

describe("WebSocket upgrade", () => {
  it("rejects an upgrade from the wrong origin", async () => {
    const spy = spyOnModel();
    const v = await visitor();
    await expectProblem(
      await upgrade({ cookie: v.cookie, origin: "https://evil.example" }),
      403
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects an upgrade with no Origin header", async () => {
    const v = await visitor();
    await expectProblem(await upgrade({ cookie: v.cookie, origin: null }), 403);
  });

  it("rejects an upgrade with no cookie", async () => {
    await expectProblem(await upgrade({}), 401);
  });

  it("rejects an upgrade for another visitor's agent", async () => {
    const alice = await visitor();
    const bob = await visitor();
    await expectProblem(
      await upgrade({ cookie: alice.cookie, name: bob.payload.sid }),
      403
    );
  });

  it("accepts the visitor's own upgrade", async () => {
    const v = await visitor();
    const res = await upgrade({ cookie: v.cookie });
    expect(res.status).toBe(101);
    res.webSocket?.accept();
    res.webSocket?.close();
  });

  it("rate limits upgrades per visitor with 429", async () => {
    const v = await visitor();
    for (let i = 0; i < LIMITS.rateLimits.connectPerVisitor.limit; i++) {
      const res = await upgrade({ cookie: v.cookie });
      res.webSocket?.accept();
      res.webSocket?.close();
    }
    await expectProblem(await upgrade({ cookie: v.cookie }), 429);
  });
});

describe("rate limit config", () => {
  it("matches the literals Wrangler needs", () => {
    const config = JSON.parse(wranglerConfig) as {
      ratelimits: { name: string; simple: { limit: number; period: number } }[];
    };
    const byName = Object.fromEntries(
      config.ratelimits.map((r) => [r.name, r.simple])
    );
    expect(byName.SESSION_LIMITER).toEqual({
      limit: LIMITS.rateLimits.sessionPerIp.limit,
      period: LIMITS.rateLimits.sessionPerIp.periodSeconds
    });
    expect(byName.CONNECT_LIMITER).toEqual({
      limit: LIMITS.rateLimits.connectPerVisitor.limit,
      period: LIMITS.rateLimits.connectPerVisitor.periodSeconds
    });
  });
});

describe("security headers", () => {
  function expectSecurityHeaders(res: Response) {
    expect(res.headers.get("content-security-policy")).toBe(
      CONTENT_SECURITY_POLICY
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  }

  it("sets CSP, nosniff and no-referrer on JSON and problem responses", async () => {
    expectSecurityHeaders(await session());
    expectSecurityHeaders(await SELF.fetch(`${BASE}/nope`));
    const v = await visitor();
    expectSecurityHeaders(
      await SELF.fetch(`${BASE}/agents/tenant-agent/me/get-messages`, {
        headers: { cookie: v.cookie }
      })
    );
  });

  it("leaves the WebSocket upgrade response alone", async () => {
    const v = await visitor();
    const res = await upgrade({ cookie: v.cookie });
    expect(res.status).toBe(101);
    expect(res.headers.get("content-security-policy")).toBeNull();
    res.webSocket?.accept();
    res.webSocket?.close();
  });

  it("allows only same-origin scripts, styles and images, the app socket, and no framing", () => {
    const directives = Object.fromEntries(
      CONTENT_SECURITY_POLICY.split("; ").map((d) => {
        const [name, ...values] = d.split(" ");
        return [name, values];
      })
    );
    expect(directives["default-src"]).toEqual(["'self'"]);
    expect(directives["script-src"]).toEqual(["'self'"]);
    expect(directives["style-src"]).toEqual(["'self'"]);
    expect(directives["img-src"]).toEqual(["'self'"]);
    expect(directives["connect-src"]).toEqual([
      "'self'",
      "wss://hostname-doctor.bhatnagarashwabh.workers.dev"
    ]);
    expect(directives["frame-ancestors"]).toEqual(["'none'"]);
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/unsafe-(eval|inline)/);
  });

  it("writes the same headers into the static assets' _headers file", () => {
    const lines = headersFile().split("\n");
    expect(lines[0]).toBe("/*");
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(lines).toContain(`  ${name}: ${value}`);
    }
  });
});

describe("GET /healthz", () => {
  it("answers ok with no session, no model call and nothing about the account", async () => {
    const spy = spyOnModel();
    const res = await SELF.fetch(`${BASE}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(spy).not.toHaveBeenCalled();
  });

  it("allows only GET", async () => {
    const res = await SELF.fetch(`${BASE}/healthz`, {
      method: "POST",
      headers: { origin: ORIGIN }
    });
    expect(res.status).toBe(405);
  });
});
