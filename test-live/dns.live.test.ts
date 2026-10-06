// Live DNS against cloudflare-dns.com. Opt in with `npm run test:live-dns`.
// The DuckDNS case needs LIVE_DUCKDNS_TXT set to the TXT value currently on the demo
// domain. Without it that case is skipped, never run against a guessed value.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { LIMITS } from "../src/config/limits";
import { MemoryDnsCache } from "../src/dns/cache";
import { diagnose } from "../src/dns/diagnose";
import { DohClient, defaultDohDeps } from "../src/dns/doh";

const FALLBACK = "hostname-doctor.bhatnagarashwabh.workers.dev";
const DUCKDNS_TXT = (env as { LIVE_DUCKDNS_TXT?: string }).LIVE_DUCKDNS_TXT;

async function live(hostname: string, token: string) {
  const client = new DohClient(defaultDohDeps(new MemoryDnsCache()));
  const result = await diagnose(client, {
    hostname,
    token,
    fallbackOrigin: FALLBACK
  });
  console.log(
    hostname,
    JSON.stringify(result.findings.map((f) => [f.code, f.severity])),
    `lookups=${result.lookups}`
  );
  return result;
}

const codes = (r: { findings: { code: string }[] }) =>
  r.findings.map((f) => f.code);

describe("live DNS", () => {
  it("example.com: apex, no verification TXT, no blocking CAA", async () => {
    const r = await live("example.com", "not-the-real-token");
    expect(codes(r)).toContain("TXT_MISSING");
    expect(codes(r)).toContain("APEX_CNAME");
    expect(codes(r)).not.toContain("CAA_BLOCKS");
    expect(r.verifiable).toBe(false);
    expect(r.lookups).toBeLessThanOrEqual(LIMITS.dns.maxLookupsPerDiagnosis);
  });

  it.skipIf(!DUCKDNS_TXT)(
    "ashwabh-demo.duckdns.org: the DuckDNS TXT verifies, and it is treated as an apex (needs LIVE_DUCKDNS_TXT)",
    async () => {
      const r = await live("ashwabh-demo.duckdns.org", DUCKDNS_TXT ?? "");
      expect(codes(r)).not.toContain("TXT_MISSING");
      expect(codes(r)).not.toContain("TXT_MISMATCH");
      expect(codes(r)).toContain("APEX_CNAME");
      expect(r.verifiable).toBe(true);
    }
  );
});
