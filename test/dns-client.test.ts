// Fixture tests for the DoH client: endpoint, retries, timeouts, caps, cache and budget.
import { describe, expect, it } from "vitest";
import { LIMITS } from "../src/config/limits";
import { isQuerySafe } from "../src/dns/doh";
import {
  decodeTxtData,
  parseCaaData,
  sanitizeDnsText,
  sanitizeRecords
} from "../src/dns/text";
import { empty, nxdomain, servfail, testClient, txt } from "./dns-fixtures";

const NAME = "_cf-custom-hostname.shop.example.com";

describe("DoH client", () => {
  it("asks only cloudflare-dns.com for JSON", async () => {
    const { client, resolver } = testClient({
      [`TXT ${NAME}`]: txt(NAME, "abc")
    });
    const result = await client.lookup(NAME, "TXT");
    expect(result).toMatchObject({ status: "ok" });
    expect(resolver.calls).toEqual([`TXT ${NAME}`]);
  });

  it("refuses names that are not plain DNS names, without any fetch", async () => {
    const { client, resolver } = testClient({});
    for (const name of [
      "Shop.Example.com",
      "a..b",
      "x/y.com",
      "",
      "evil.com:443",
      `${"a".repeat(64)}.com`
    ]) {
      expect(await client.lookup(name, "TXT")).toEqual({
        status: "error",
        reason: "bad_name"
      });
    }
    expect(resolver.calls).toEqual([]);
    expect(isQuerySafe("co.uk")).toBe(true);
  });

  it("times out after the configured time and does not retry or cache a timeout", async () => {
    const { client, resolver, cache } = testClient({
      [`TXT ${NAME}`]: { kind: "timeout" }
    });
    expect(await client.lookup(NAME, "TXT")).toEqual({ status: "timeout" });
    expect(resolver.calls).toHaveLength(1);
    expect(cache.expiryOf(NAME, "TXT")).toBeNull();
  });

  it("uses the 3 second timeout from limits by default", () => {
    expect(LIMITS.dns.timeoutMs).toBe(3000);
  });

  it("retries once after a network error, with 200 to 500 ms jitter", async () => {
    const { client, resolver, sleeps } = testClient({
      [`TXT ${NAME}`]: [{ kind: "network" }, txt(NAME, "abc")]
    });
    expect(await client.lookup(NAME, "TXT")).toMatchObject({ status: "ok" });
    expect(resolver.calls).toHaveLength(2);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(200);
    expect(sleeps[0]).toBeLessThanOrEqual(500);
  });

  it("covers the whole jitter range", async () => {
    for (const [random, expected] of [
      [0, 200],
      [0.999999, 500]
    ] as const) {
      const { client, sleeps } = testClient(
        { [`TXT ${NAME}`]: [{ kind: "http", status: 503 }, txt(NAME, "a")] },
        { random: () => random }
      );
      await client.lookup(NAME, "TXT");
      expect(sleeps).toEqual([expected]);
    }
  });

  it("retries a 5xx once and then gives up", async () => {
    const { client, resolver } = testClient({
      [`TXT ${NAME}`]: { kind: "http", status: 502 }
    });
    expect(await client.lookup(NAME, "TXT")).toEqual({
      status: "error",
      reason: "http"
    });
    expect(resolver.calls).toHaveLength(2);
  });

  it("does not retry a 4xx", async () => {
    const { client, resolver } = testClient({
      [`TXT ${NAME}`]: { kind: "http", status: 400 }
    });
    expect(await client.lookup(NAME, "TXT")).toEqual({
      status: "error",
      reason: "http"
    });
    expect(resolver.calls).toHaveLength(1);
  });

  it("stops reading at 64 KB", async () => {
    const huge = JSON.stringify({
      Status: 0,
      Answer: [],
      pad: "x".repeat(LIMITS.dns.maxResponseBytes)
    });
    const { client } = testClient({
      [`TXT ${NAME}`]: { kind: "raw", body: huge }
    });
    expect(await client.lookup(NAME, "TXT")).toEqual({
      status: "error",
      reason: "too_large"
    });
  });

  it("treats malformed JSON as an error", async () => {
    const { client } = testClient({
      [`TXT ${NAME}`]: { kind: "raw", body: "<html>" }
    });
    expect(await client.lookup(NAME, "TXT")).toEqual({
      status: "error",
      reason: "bad_response"
    });
    const { client: c2 } = testClient({
      [`TXT ${NAME}`]: { kind: "raw", body: '{"Answer":"nope"}' }
    });
    expect(await c2.lookup(NAME, "TXT")).toEqual({
      status: "error",
      reason: "bad_response"
    });
  });

  it("maps resolver status codes", async () => {
    const { client } = testClient({
      [`TXT ${NAME}`]: nxdomain,
      [`CAA ${NAME}`]: servfail
    });
    expect(await client.lookup(NAME, "TXT")).toEqual({ status: "nxdomain" });
    expect(await client.lookup(NAME, "CAA")).toEqual({ status: "servfail" });
  });
});

describe("DNS cache", () => {
  it("caches answers for min(TTL, 60 s) and serves them without a fetch", async () => {
    const short = {
      kind: "answer" as const,
      Answer: [{ name: `${NAME}.`, type: 16, TTL: 30, data: '"a"' }]
    };
    const { client, cache, clock, resolver } = testClient({
      [`TXT ${NAME}`]: short,
      [`CAA ${NAME}`]: txt(NAME, "b")
    });
    await client.lookup(NAME, "TXT");
    expect(cache.expiryOf(NAME, "TXT")).toBe(clock.now + 30_000);
    await client.lookup(NAME, "CAA");
    expect(cache.expiryOf(NAME, "CAA")).toBe(clock.now + 60_000);
    await client.lookup(NAME, "TXT");
    expect(resolver.calls).toHaveLength(2);
  });

  it("caches an empty or NXDOMAIN answer by its SOA TTL, capped at 60 s", async () => {
    const { client, cache, clock } = testClient({
      [`TXT ${NAME}`]: empty,
      [`CAA ${NAME}`]: nxdomain
    });
    await client.lookup(NAME, "TXT");
    await client.lookup(NAME, "CAA");
    expect(cache.expiryOf(NAME, "TXT")).toBe(clock.now + 60_000);
    expect(cache.expiryOf(NAME, "CAA")).toBe(clock.now + 60_000);
  });

  it("caches SERVFAIL for at most 10 s", async () => {
    const { client, cache, clock } = testClient({ [`TXT ${NAME}`]: servfail });
    await client.lookup(NAME, "TXT");
    expect(cache.expiryOf(NAME, "TXT")).toBe(clock.now + 10_000);
  });

  it("expires entries", async () => {
    const { client, clock, resolver } = testClient({
      [`TXT ${NAME}`]: servfail
    });
    await client.lookup(NAME, "TXT");
    clock.now += 10_001;
    await client.lookup(NAME, "TXT");
    expect(resolver.calls).toHaveLength(2);
  });
});

describe("lookup budget", () => {
  it("allows 12 lookups per client and refuses the 13th without a fetch", async () => {
    const { client, resolver } = testClient({});
    for (let i = 0; i < LIMITS.dns.maxLookupsPerDiagnosis; i++) {
      await client.lookup(`n${i}.example.com`, "TXT");
    }
    expect(await client.lookup("last.example.com", "TXT")).toEqual({
      status: "error",
      reason: "budget"
    });
    expect(resolver.calls).toHaveLength(12);
  });
});

describe("DNS text", () => {
  it("strips control, zero-width and bidi characters", () => {
    const hostile =
      "a\u0000b\u0007c\u001bd\u007fe\u0085f\u200bg\u200dh\ufeffi\u202ej\u2066k\u2069l\u200fm\u061cn";
    expect(sanitizeDnsText(hostile)).toBe("abcdefghijklmn");
  });

  it("caps strings at 255 characters and names at 10 records", () => {
    expect(sanitizeDnsText("x".repeat(4000))).toHaveLength(255);
    const many = sanitizeRecords(Array.from({ length: 25 }, (_, i) => `r${i}`));
    expect(many.values).toHaveLength(10);
    expect(many.truncated).toBe(true);
  });

  it("decodes TXT presentation data", () => {
    expect(decodeTxtData('"abc"')).toBe("abc");
    expect(decodeTxtData('"part one" "part two"')).toBe("part onepart two");
    expect(decodeTxtData('"say \\"hi\\" \\\\ \\065"')).toBe('say "hi" \\ A');
    expect(decodeTxtData("plain")).toBe("plain");
  });

  it("parses CAA in presentation and generic form", () => {
    expect(parseCaaData('0 issue "letsencrypt.org"')).toEqual({
      critical: false,
      tag: "issue",
      value: "letsencrypt.org"
    });
    expect(parseCaaData('128 tbs "x"')).toEqual({
      critical: true,
      tag: "tbs",
      value: "x"
    });
    // 0 issue "pki.goog" as RFC 3597 hex
    expect(
      parseCaaData("\\# 15 00 05 69 73 73 75 65 70 6b 69 2e 67 6f 6f 67")
    ).toEqual({
      critical: false,
      tag: "issue",
      value: "pki.goog"
    });
    expect(parseCaaData("garbage")).toBeNull();
  });
});
