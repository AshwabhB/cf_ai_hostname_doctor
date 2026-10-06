import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { LIMITS } from "../src/config/limits";
import {
  cookieName,
  decodeSession,
  encodeSession,
  needsRenewal,
  newSession,
  readCookie,
  setCookieHeader
} from "../src/security/session";
import { nowSeconds } from "./helpers";

const secret = env.SESSION_SECRET;

function flipLastChar(text: string) {
  const last = text.at(-1) === "A" ? "B" : "A";
  return text.slice(0, -1) + last;
}

describe("session token", () => {
  it("round-trips a fresh session", async () => {
    const payload = newSession(nowSeconds());
    const token = await encodeSession(payload, secret);
    expect(await decodeSession(token, secret, nowSeconds())).toEqual({
      ok: true,
      payload
    });
  });

  it("issues a 128-bit hex sid that lasts 30 days", () => {
    const now = nowSeconds();
    const s = newSession(now);
    expect(s.sid).toMatch(/^[0-9a-f]{32}$/);
    expect(s.exp - s.iat).toBe(30 * 24 * 60 * 60);
    expect(newSession(now).sid).not.toBe(s.sid);
  });

  it("rejects a tampered payload", async () => {
    const token = await encodeSession(newSession(nowSeconds()), secret);
    const [body, sig] = token.split(".");
    const forged = btoa(
      JSON.stringify({
        ...JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/"))),
        sid: "f".repeat(32)
      })
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const result = await decodeSession(
      `${forged}.${sig}`,
      secret,
      nowSeconds()
    );
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a tampered signature", async () => {
    const token = await encodeSession(newSession(nowSeconds()), secret);
    const result = await decodeSession(
      flipLastChar(token),
      secret,
      nowSeconds()
    );
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a token signed with another secret", async () => {
    const token = await encodeSession(newSession(nowSeconds()), "x".repeat(40));
    const result = await decodeSession(token, secret, nowSeconds());
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects an expired token even with a valid signature", async () => {
    const now = nowSeconds();
    const token = await encodeSession({ ...newSession(now), exp: now }, secret);
    expect(await decodeSession(token, secret, now)).toEqual({
      ok: false,
      reason: "expired"
    });
  });

  it("rejects a signed payload with unknown fields", async () => {
    const payload = { ...newSession(nowSeconds()), admin: true };
    const token = await encodeSession(payload, secret);
    expect(await decodeSession(token, secret, nowSeconds())).toEqual({
      ok: false,
      reason: "malformed"
    });
  });

  it("rejects garbage", async () => {
    for (const token of ["", "abc", "a.b.c", "!!!.???"]) {
      const result = await decodeSession(token, secret, nowSeconds());
      expect(result.ok).toBe(false);
    }
  });

  it("renews only inside the last week", () => {
    const now = nowSeconds();
    const s = newSession(now);
    expect(needsRenewal(s, now)).toBe(false);
    const late = s.exp - LIMITS.session.renewWithinSeconds + 1;
    expect(needsRenewal(s, late)).toBe(true);
  });
});

describe("cookie", () => {
  it("uses the __Host- prefix with Secure, HttpOnly, Path=/, SameSite=Lax and no Domain", () => {
    const now = nowSeconds();
    const header = setCookieHeader("tok", newSession(now), env, now);
    expect(header.startsWith("__Host-hd_sid=tok;")).toBe(true);
    for (const attr of ["Path=/", "Secure", "HttpOnly", "SameSite=Lax"]) {
      expect(header).toContain(attr);
    }
    expect(header).not.toMatch(/domain=/i);
    expect(header).toContain(`Max-Age=${LIMITS.session.ttlSeconds}`);
  });

  it("drops only the prefix in dev mode", () => {
    const now = nowSeconds();
    const devEnv = { ...env, COOKIE_DEV_MODE: "true" };
    const header = setCookieHeader("tok", newSession(now), devEnv, now);
    expect(header.startsWith("hd_sid=tok;")).toBe(true);
    expect(header).toContain("Secure");
    expect(header).toContain("HttpOnly");
  });

  it("ignores a cookie sent twice", () => {
    const name = cookieName(env);
    const req = new Request("https://x/", {
      headers: { cookie: `${name}=a; ${name}=b` }
    });
    expect(readCookie(req, env)).toBeNull();
  });

  it("does not accept the unprefixed name outside dev mode", () => {
    const req = new Request("https://x/", { headers: { cookie: "hd_sid=a" } });
    expect(readCookie(req, env)).toBeNull();
  });
});

describe("test environment", () => {
  it("runs on the test-only secret, never the one in .dev.vars", () => {
    expect(env.SESSION_SECRET).toBe(
      "test-only-session-secret-not-used-anywhere-else"
    );
    expect(env.COOKIE_DEV_MODE).toBe("false");
  });
});
