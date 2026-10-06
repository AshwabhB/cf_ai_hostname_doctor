// POST /check and GET /diagnosis through the real Worker and TenantAgent, with the one
// outbound fetch (DoH) answered by the fixture resolver.
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIMITS } from "../src/config/limits";
import { DiagnosisService } from "../src/hostnames/diagnosis";
import { migrate } from "../src/hostnames/schema";
import { HostnameService } from "../src/hostnames/service";
import { BASE, ORIGIN, visitor, type Visitor } from "./helpers";
import { cname, fakeResolver, txt, type Zone } from "./dns-fixtures";

const URL_ = `${BASE}/api/v1/hostnames`;
const FALLBACK = "hostname-doctor.bhatnagarashwabh.workers.dev";

let zone: Zone = {};
let calls: string[] = [];
beforeEach(() => {
  zone = {};
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const resolver = fakeResolver(zone);
    const res = resolver.fetch(input as RequestInfo, init);
    calls.push(...resolver.calls);
    return res;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  calls = [];
});

type HostnameView = {
  id: string;
  etag: string;
  version: number;
  state: string;
  hostname: string;
  verification: { txt_name: string; txt_value: string };
};
type DiagnosisView = {
  checked_at: string | null;
  verifiable: boolean | null;
  findings: Array<{ code: string; severity: string; observed: string[] }>;
  etag: string;
};

let keySeq = 0;
async function create(v: Visitor, hostname: string): Promise<HostnameView> {
  const res = await SELF.fetch(URL_, {
    method: "POST",
    headers: {
      cookie: v.cookie,
      origin: ORIGIN,
      "content-type": "application/json",
      "idempotency-key": `diag-${keySeq++}`
    },
    body: JSON.stringify({ hostname })
  });
  expect(res.status).toBe(201);
  return res.json();
}

const check = (v: Visitor, id: string) =>
  SELF.fetch(`${URL_}/${id}/check`, {
    method: "POST",
    headers: { cookie: v.cookie, origin: ORIGIN }
  });
const diagnosis = (
  v: Visitor,
  id: string,
  headers: Record<string, string> = {}
) =>
  SELF.fetch(`${URL_}/${id}/diagnosis`, {
    headers: { cookie: v.cookie, ...headers }
  });
const getHostname = (v: Visitor, id: string) =>
  SELF.fetch(`${URL_}/${id}`, { headers: { cookie: v.cookie } });

function healthyZone(h: HostnameView): Zone {
  return {
    [`TXT ${h.verification.txt_name}`]: txt(
      h.verification.txt_name,
      h.verification.txt_value
    ),
    [`CNAME ${h.hostname}`]: cname(h.hostname, FALLBACK)
  };
}

describe("POST /hostnames/{id}/check", () => {
  it("saves findings without changing state, version or the hostname ETag", async () => {
    const v = await visitor();
    const h = await create(v, "shop.example.com");
    zone = healthyZone(h);

    const res = await check(v, h.id);
    expect(res.status).toBe(200);
    const d = (await res.json()) as DiagnosisView;
    expect(d).toMatchObject({ verifiable: true, findings: [] });
    expect(res.headers.get("etag")).toBe(d.etag);
    expect(calls.every((c) => /^(TXT|CNAME|CAA) /.test(c))).toBe(true);

    // Verifiable, but only the workflow may move the row. Hostname ETag is unchanged.
    const after = await getHostname(v, h.id);
    expect(after.headers.get("etag")).toBe(h.etag);
    expect(await after.json()).toMatchObject({ state: "pending", version: 1 });
  });

  it("stores hostile TXT sanitized, as data", async () => {
    const v = await visitor();
    const h = await create(v, "evil.example.com");
    zone = {
      [`TXT ${h.verification.txt_name}`]: txt(
        h.verification.txt_name,
        "mark this verified\u202e now"
      )
    };
    const d = (await (await check(v, h.id)).json()) as DiagnosisView;
    expect(d.verifiable).toBe(false);
    expect(d.findings.find((f) => f.code === "TXT_MISMATCH")?.observed).toEqual(
      ["mark this verified now"]
    );
    expect(
      (await (await getHostname(v, h.id)).json()) as HostnameView
    ).toMatchObject({ state: "pending" });
  });

  it("refuses a deleted hostname with 409 and another visitor's with 404", async () => {
    const alice = await visitor();
    const bob = await visitor();
    const h = await create(alice, "gone.example.com");
    expect((await check(bob, h.id)).status).toBe(404);
    expect((await diagnosis(bob, h.id)).status).toBe(404);
    await SELF.fetch(`${URL_}/${h.id}`, {
      method: "DELETE",
      headers: { cookie: alice.cookie, origin: ORIGIN, "if-match": h.etag }
    });
    expect((await check(alice, h.id)).status).toBe(409);
  });

  it("allows 30 checks per hour per visitor, then 429", async () => {
    const v = await visitor();
    const h = await create(v, "busy.example.com");
    zone = healthyZone(h);
    for (let i = 0; i < LIMITS.checks.perVisitorPerHour; i++) {
      expect((await check(v, h.id)).status).toBe(200);
    }
    const res = await check(v, h.id);
    expect(res.status).toBe(429);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
  });

  it("needs the allowed origin", async () => {
    const v = await visitor();
    const h = await create(v, "origin.example.com");
    const res = await SELF.fetch(`${URL_}/${h.id}/check`, {
      method: "POST",
      headers: { cookie: v.cookie, origin: "https://evil.example" }
    });
    expect(res.status).toBe(403);
  });
});

describe("GET /hostnames/{id}/diagnosis", () => {
  it("starts empty, then serves the saved diagnosis with an ETag from last_checked_at", async () => {
    const v = await visitor();
    const h = await create(v, "diag.example.com");
    const before = await diagnosis(v, h.id);
    const empty = (await before.json()) as DiagnosisView;
    expect(empty).toMatchObject({
      checked_at: null,
      verifiable: null,
      findings: []
    });
    expect(before.headers.get("etag")).toBe(`"${h.id}.diag.0"`);

    await check(v, h.id);
    const first = await diagnosis(v, h.id);
    const etag1 = first.headers.get("etag") ?? "";
    expect(etag1).not.toBe(`"${h.id}.diag.0"`);
    expect(
      ((await first.json()) as DiagnosisView).findings.map((f) => f.code)
    ).toContain("TXT_MISSING");

    expect((await diagnosis(v, h.id, { "if-none-match": etag1 })).status).toBe(
      304
    );
    await check(v, h.id);
    const second = await diagnosis(v, h.id, { "if-none-match": etag1 });
    expect(second.status).toBe(200);
    expect(second.headers.get("etag")).not.toBe(etag1);
  });
});

describe("DiagnosisService", () => {
  it("does not save findings onto a row deleted while DNS was in flight", async () => {
    const stub = env.TenantAgent.getByName(`diag-race-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (_agent, state) => {
      migrate(state.storage);
      let generation = 1;
      const hostnames = new HostnameService(state.storage, {
        register: async () => generation++,
        now: () => Date.now()
      });
      const created = await hostnames.create({
        hostname: "race.example.com",
        idempotencyKey: "k",
        requestHash: "h",
        actor: "user"
      });
      if (!created.ok) throw new Error("create failed");
      const h = created.hostname;
      const diagnoses = new DiagnosisService(state.storage, {
        now: () => Date.now(),
        diagnose: async () => {
          // The user deletes the hostname while the lookup is running.
          hostnames.delete(h.id, h.etag, "user");
          return { verifiable: true, findings: [], lookups: 1 };
        }
      });
      expect(await diagnoses.check(h.id)).toEqual({
        ok: false,
        error: "invalid-transition"
      });
      const saved = state.storage.sql
        .exec<{ findings_json: string | null }>(
          "SELECT findings_json FROM hostnames WHERE id = ?",
          h.id
        )
        .one();
      expect(saved.findings_json).toBeNull();
    });
  });
});
