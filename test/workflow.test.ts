// VerifyWorkflow, the registry and reconcile, run on the real Workflows binding in the
// pool. Sleeps are skipped with the workflow test helpers. DNS comes from the fixture
// resolver, so nothing reaches the network.
import {
  SELF,
  env,
  introspectWorkflow,
  runInDurableObject
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIMITS } from "../src/config/limits";
import { HostnameService } from "../src/hostnames/service";
import { HostnameRegistry, TenantAgent } from "../src/server";
import { worstCaseSteps, sleepAfter } from "../src/workflow/schedule";
import { BASE, ORIGIN, visitor, type Visitor } from "./helpers";
import { fakeResolver, txt, type Zone } from "./dns-fixtures";
import { refusedFetches } from "./setup";

// TXT values served per verification name. Tests add tokens as they learn them.
let txtByName = new Map<string, string[]>();

beforeEach(() => {
  txtByName = new Map();
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const zone: Zone = {};
    for (const [name, values] of txtByName)
      zone[`TXT ${name}`] = txt(name, ...values);
    return fakeResolver(zone).fetch(input as RequestInfo, init);
  });
});
afterEach(() => vi.restoreAllMocks());

type View = {
  id: string;
  hostname: string;
  etag: string;
  generation: number;
  state: string;
  verification: { txt_name: string; txt_value: string };
  certificate: { simulated: boolean; issuer: string } | null;
};

async function create(v: Visitor, hostname: string): Promise<View> {
  const res = await SELF.fetch(`${BASE}/api/v1/hostnames`, {
    method: "POST",
    headers: {
      cookie: v.cookie,
      origin: ORIGIN,
      "content-type": "application/json",
      "idempotency-key": crypto.randomUUID()
    },
    body: JSON.stringify({ hostname })
  });
  expect(res.status).toBe(201);
  return res.json();
}

async function get(v: Visitor, id: string): Promise<View> {
  return (
    await SELF.fetch(`${BASE}/api/v1/hostnames/${id}`, {
      headers: { cookie: v.cookie }
    })
  ).json();
}

function serveToken(h: View, ...extra: string[]) {
  txtByName.set(h.verification.txt_name, [
    ...(txtByName.get(h.verification.txt_name) ?? []),
    h.verification.txt_value,
    ...extra
  ]);
}

async function waitForState(
  v: Visitor,
  id: string,
  states: string[],
  timeoutMs = 20_000
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const h = await get(v, id);
    if (states.includes(h.state)) return h;
    if (Date.now() > deadline)
      throw new Error(`still ${h.state}, wanted ${states.join("|")}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const agent = (v: Visitor) => env.TenantAgent.getByName(v.payload.sid);

async function events(v: Visitor, id: string) {
  return runInDurableObject(agent(v), (_a, state) =>
    state.storage.sql
      .exec<{ to_state: string; actor: string; generation: number }>(
        "SELECT to_state, actor, generation FROM events WHERE hostname_id = ? ORDER BY id",
        id
      )
      .toArray()
  );
}

async function workflowRow(v: Visitor, id: string) {
  return runInDurableObject(agent(v), (a: TenantAgent, state) => {
    void a;
    return state.storage.sql
      .exec<{
        workflow_instance_id: string | null;
        workflow_run: number;
        registry_released: number;
      }>(
        "SELECT workflow_instance_id, workflow_run, registry_released FROM hostnames WHERE id = ?",
        id
      )
      .one();
  });
}

const owner = (hostname: string) =>
  env.HostnameRegistry.getByName(hostname).owner();

async function skipSleeps() {
  const introspector = await introspectWorkflow(env.VERIFY_WORKFLOW);
  await introspector.modifyAll(async (m) => {
    await m.disableSleeps();
    await m.disableRetryDelays();
  });
  return introspector;
}

describe("schedule", () => {
  it("follows 30 s, 1 m, 2 m, 5 m, then 10 m, and gives up after 24 h of sleeps", () => {
    expect([0, 1, 2, 3, 4, 50].map(sleepAfter)).toEqual([
      30, 60, 120, 300, 600, 600
    ]);
    expect(worstCaseSteps()).toEqual({
      attempts: 149,
      sleeps: 148,
      steps: 450
    });
  });

  it("stays under half of the Free plan's 1,024 steps per instance", () => {
    expect(worstCaseSteps().steps).toBeLessThanOrEqual(
      LIMITS.verify.stepLimitFloor / 2
    );
  });
});

describe("happy path", () => {
  it("goes pending, verified, active with a simulated certificate and the registry claim", async () => {
    const introspector = await skipSleeps();
    try {
      const v = await visitor();
      const h = await create(v, "shop.example.com");
      serveToken(h);
      const active = await waitForState(v, h.id, ["active"]);
      expect(active.certificate).toMatchObject({
        simulated: true,
        issuer: "Simulated"
      });
      expect(
        (await events(v, h.id)).map((e) => `${e.to_state}:${e.actor}`)
      ).toEqual(["pending:user", "verified:system", "active:system"]);
      expect(await owner("shop.example.com")).toEqual({
        tenant: v.payload.sid,
        generation: h.generation
      });
      // The summary was pushed with server setState.
      const pushed = await runInDurableObject(
        agent(v),
        (a: TenantAgent) => a.state
      );
      expect(
        pushed.hostnames.find((x) => x.hostname === "shop.example.com")?.state
      ).toBe("active");
      const [instance] = await introspector.get();
      await instance.waitForStatus("complete");
      expect(await instance.getOutput()).toEqual({ outcome: "active" });
    } finally {
      await introspector.dispose();
    }
  });

  it("never reaches the network: without a fixture, DoH calls are refused", async () => {
    vi.restoreAllMocks();
    const introspector = await introspectWorkflow(env.VERIFY_WORKFLOW);
    try {
      const v = await visitor();
      const before = refusedFetches.length;
      await create(v, "offline.example.com");
      const [instance] = await introspector.get();
      const dns = (await instance.waitForStepResult({ name: "dns-0" })) as {
        findings: { code: string }[];
      };
      expect(dns.findings.map((f) => f.code)).toContain("DNS_ERROR");
      expect(
        refusedFetches
          .slice(before)
          .every((u) => u.startsWith("https://cloudflare-dns.com/"))
      ).toBe(true);
      expect(refusedFetches.length).toBeGreaterThan(before);
    } finally {
      await introspector.dispose();
    }
  });
});

describe("steps running twice", () => {
  it("claim, settle and activate that commit but lose their result run again harmlessly", async () => {
    // Each first call does its work and then throws, as if the step's result were lost.
    // The engine retries the step, so the same call runs a second time.
    const original = {
      settle: TenantAgent.prototype.wfSettle,
      activate: TenantAgent.prototype.wfActivate,
      claim: HostnameRegistry.prototype.claim
    };
    const calls = { settle: 0, activate: 0, claim: 0 };
    vi.spyOn(TenantAgent.prototype, "wfSettle").mockImplementation(function (
      this: TenantAgent,
      ...args
    ) {
      calls.settle++;
      const r = original.settle.apply(this, args);
      if (calls.settle === 1) throw new Error("result lost after commit");
      return r;
    });
    vi.spyOn(TenantAgent.prototype, "wfActivate").mockImplementation(function (
      this: TenantAgent,
      ...args
    ) {
      calls.activate++;
      const r = original.activate.apply(this, args);
      if (calls.activate === 1) throw new Error("result lost after commit");
      return r;
    });
    vi.spyOn(HostnameRegistry.prototype, "claim").mockImplementation(function (
      this: HostnameRegistry,
      ...args
    ) {
      calls.claim++;
      const r = original.claim.apply(this, args);
      if (calls.claim === 1) throw new Error("result lost after commit");
      return r;
    });
    const introspector = await skipSleeps();
    try {
      const v = await visitor();
      const h = await create(v, "twice.example.com");
      serveToken(h);
      await waitForState(v, h.id, ["active"]);
      expect(calls).toEqual({ settle: 2, activate: 2, claim: 2 });
      const moves = (await events(v, h.id)).map((e) => e.to_state);
      expect(moves).toEqual(["pending", "verified", "active"]);
      expect(await owner("twice.example.com")).toEqual({
        tenant: v.payload.sid,
        generation: h.generation
      });
    } finally {
      await introspector.dispose();
    }
  });

  it("each callback is a no-op when repeated", async () => {
    const v = await visitor();
    await runInDurableObject(agent(v), async (a: TenantAgent, state) => {
      const svc = state.storage.sql;
      void svc;
      const created = await a.apiCreate({
        hostname: "repeat.example.com",
        idempotencyKey: "k",
        requestHash: "h",
        actor: "user"
      });
      if (!created.ok) throw new Error("create failed");
      const { id, generation } = created.hostname;
      expect(a.wfSettle(id, generation, true).ok).toBe(true);
      expect(a.wfSettle(id, generation, true).ok).toBe(true);
      expect(a.wfActivate(id, generation, Date.now()).ok).toBe(true);
      expect(a.wfActivate(id, generation, Date.now()).ok).toBe(true);
      const count = state.storage.sql
        .exec<{ n: number }>(
          "SELECT COUNT(*) AS n FROM events WHERE hostname_id = ?",
          id
        )
        .one().n;
      expect(count).toBe(3);
    });
  });
});

describe("delete", () => {
  it("terminates a polling workflow, releases nothing it never claimed, then deletes", async () => {
    const introspector = await introspectWorkflow(env.VERIFY_WORKFLOW);
    try {
      const v = await visitor();
      const h = await create(v, "mid.example.com");
      const [instance] = await introspector.get();
      await instance.waitForStepResult({ name: "record-0" });
      const res = await SELF.fetch(`${BASE}/api/v1/hostnames/${h.id}`, {
        method: "DELETE",
        headers: { cookie: v.cookie, origin: ORIGIN, "if-match": h.etag }
      });
      expect(res.status).toBe(202);
      expect(((await res.json()) as View).state).toBe("deleted");
      await instance.waitForStatus("terminated");
      expect((await workflowRow(v, h.id)).registry_released).toBe(1);
      expect((await events(v, h.id)).map((e) => e.to_state)).toEqual([
        "pending",
        "deleting",
        "deleted"
      ]);
    } finally {
      await introspector.dispose();
    }
  });

  it("releases the claim of an active hostname, so another visitor can verify it", async () => {
    const introspector = await skipSleeps();
    try {
      const alice = await visitor();
      const h = await create(alice, "handover.example.com");
      serveToken(h);
      const active = await waitForState(alice, h.id, ["active"]);
      await SELF.fetch(`${BASE}/api/v1/hostnames/${h.id}`, {
        method: "DELETE",
        headers: {
          cookie: alice.cookie,
          origin: ORIGIN,
          "if-match": active.etag
        }
      });
      expect(await owner("handover.example.com")).toBeNull();
      const bob = await visitor();
      const b = await create(bob, "handover.example.com");
      serveToken(b);
      await waitForState(bob, b.id, ["active"]);
    } finally {
      await introspector.dispose();
    }
  });

  it("fences late steps after delete and after re-add with a new generation", async () => {
    const v = await visitor();
    await runInDurableObject(agent(v), async (a: TenantAgent, state) => {
      const first = await a.apiCreate({
        hostname: "late.example.com",
        idempotencyKey: "a",
        requestHash: "a",
        actor: "user"
      });
      if (!first.ok) throw new Error("create failed");
      const old = first.hostname;
      await a.apiDelete(old.id, old.etag);
      const second = await a.apiCreate({
        hostname: "late.example.com",
        idempotencyKey: "b",
        requestHash: "b",
        actor: "user"
      });
      if (!second.ok) throw new Error("create failed");

      const late = {
        verifiable: true,
        findings: [],
        lookups: 1,
        checkedAt: Date.now()
      };
      expect(a.wfLoad(old.id, old.generation)).toBeNull();
      expect(a.wfRecord(old.id, old.generation, late)).toEqual({ live: false });
      expect(a.wfSettle(old.id, old.generation, true).ok).toBe(false);
      expect(a.wfActivate(old.id, old.generation, Date.now()).ok).toBe(false);
      // The old generation's late steps never touch the new row either.
      expect(a.wfSettle(second.hostname.id, old.generation, true).ok).toBe(
        false
      );
      const rows = state.storage.sql
        .exec<{ state: string; generation: number }>(
          "SELECT state, generation FROM hostnames ORDER BY created_at"
        )
        .toArray();
      expect(rows).toEqual([
        { state: "deleted", generation: old.generation },
        { state: "pending", generation: second.hostname.generation }
      ]);
    });
  });
});

describe("two visitors race for one hostname", () => {
  it("the first verified claim wins and the other ends in conflict", async () => {
    const introspector = await skipSleeps();
    try {
      const alice = await visitor();
      const bob = await visitor();
      const a = await create(alice, "race.example.com");
      const b = await create(bob, "race.example.com");
      serveToken(a);
      serveToken(b);
      const [ra, rb] = await Promise.all([
        waitForState(alice, a.id, ["active", "conflict"]),
        waitForState(bob, b.id, ["active", "conflict"])
      ]);
      expect([ra.state, rb.state].sort()).toEqual(["active", "conflict"]);
      const winner = ra.state === "active" ? alice : bob;
      const winnerRow = ra.state === "active" ? ra : rb;
      expect(await owner("race.example.com")).toEqual({
        tenant: winner.payload.sid,
        generation: winnerRow.generation
      });
    } finally {
      await introspector.dispose();
    }
  });
});

describe("reconcile", () => {
  it("adopts a workflow that started when recording its id failed, without a second run", async () => {
    const introspector = await skipSleeps();
    const setWorkflow = vi
      .spyOn(HostnameService.prototype, "setWorkflow")
      .mockImplementationOnce(() => false);
    try {
      const v = await visitor();
      const h = await create(v, "lost-id.example.com");
      expect((await workflowRow(v, h.id)).workflow_instance_id).toBeNull();
      const report = await runInDurableObject(agent(v), (a: TenantAgent) =>
        a.reconcile()
      );
      expect(report.adopted).toEqual([h.id]);
      expect(report.restarted).toEqual([]);
      expect((await workflowRow(v, h.id)).workflow_instance_id).toBe(
        `${v.payload.sid}-${h.id}-g${h.generation}-r1`
      );
      serveToken(h);
      await waitForState(v, h.id, ["active"]);
      expect(await introspector.get()).toHaveLength(1);
    } finally {
      setWorkflow.mockRestore();
      await introspector.dispose();
    }
  });

  it("restarts a run the engine still calls in progress but that stopped making progress", async () => {
    // Regression: a local runtime crash lost a sleeping instance's wake-up. The engine
    // kept reporting it as in progress, so reconcile never restarted the row.
    const introspector = await introspectWorkflow(env.VERIFY_WORKFLOW);
    try {
      const v = await visitor();
      const h = await create(v, "stalled.example.com");
      const [first] = await introspector.get();
      await first.waitForStepResult({ name: "record-0" });
      // Run 1 is now sleeping for 30 s. Age its heartbeat past the stall limit.
      const aged = Date.now() - LIMITS.verify.stalledAfterMs - 60_000;
      await runInDurableObject(agent(v), (_a, state) => {
        state.storage.sql.exec(
          "UPDATE hostnames SET last_checked_at = ?, workflow_started_at = ? WHERE id = ?",
          aged,
          aged,
          h.id
        );
      });
      const runOne = `${v.payload.sid}-${h.id}-g${h.generation}-r1`;
      const before = await (await env.VERIFY_WORKFLOW.get(runOne)).status();
      expect(["waiting", "running", "queued"]).toContain(before.status);

      const report = await runInDurableObject(agent(v), (a: TenantAgent) =>
        a.reconcile()
      );
      expect(report.stalled).toEqual([h.id]);
      expect(report.restarted).toEqual([h.id]);
      expect((await workflowRow(v, h.id)).workflow_run).toBe(2);
      expect(
        (await (await env.VERIFY_WORKFLOW.get(runOne)).status()).status
      ).toBe("terminated");
    } finally {
      await introspector.dispose();
    }
  });

  it("leaves a sleeping run with a recent heartbeat alone", async () => {
    const introspector = await introspectWorkflow(env.VERIFY_WORKFLOW);
    try {
      const v = await visitor();
      const h = await create(v, "healthy-sleep.example.com");
      const [first] = await introspector.get();
      await first.waitForStepResult({ name: "record-0" });
      const report = await runInDurableObject(agent(v), (a: TenantAgent) =>
        a.reconcile()
      );
      expect(report.stalled).toEqual([]);
      expect(report.restarted).toEqual([]);
      expect((await workflowRow(v, h.id)).workflow_run).toBe(1);
    } finally {
      await introspector.dispose();
    }
  });

  it("starts the next run for a pending row whose instance is gone", async () => {
    const introspector = await skipSleeps();
    try {
      const v = await visitor();
      const h = await create(v, "restart.example.com");
      const [first] = await introspector.get();
      await first.waitForStepResult({ name: "record-0" });
      await (
        await env.VERIFY_WORKFLOW.get(
          `${v.payload.sid}-${h.id}-g${h.generation}-r1`
        )
      ).terminate();
      const report = await runInDurableObject(agent(v), (a: TenantAgent) =>
        a.reconcile()
      );
      expect(report.restarted).toEqual([h.id]);
      expect((await workflowRow(v, h.id)).workflow_run).toBe(2);
      serveToken(h);
      await waitForState(v, h.id, ["active"]);
    } finally {
      await introspector.dispose();
    }
  });

  it("releases a claim left behind by a deleted row", async () => {
    const v = await visitor();
    const report = await runInDurableObject(
      agent(v),
      async (a: TenantAgent, state) => {
        const created = await a.apiCreate({
          hostname: "leftover.example.com",
          idempotencyKey: "k",
          requestHash: "h",
          actor: "user"
        });
        if (!created.ok) throw new Error("create failed");
        const { id, generation } = created.hostname;
        await env.HostnameRegistry.getByName("leftover.example.com").claim(
          v.payload.sid,
          generation
        );
        // A delete that lost track of its release.
        state.storage.sql.exec(
          "UPDATE hostnames SET state = 'deleted', registry_released = 0 WHERE id = ?",
          id
        );
        return a.reconcile();
      }
    );
    expect(report.released).toHaveLength(1);
    expect(await owner("leftover.example.com")).toBeNull();
  });

  it("moves an active row to conflict when the registry names another owner", async () => {
    const introspector = await skipSleeps();
    try {
      const v = await visitor();
      const h = await create(v, "stolen.example.com");
      serveToken(h);
      await waitForState(v, h.id, ["active"]);
      await env.HostnameRegistry.getByName("stolen.example.com").release(
        v.payload.sid,
        h.generation
      );
      await env.HostnameRegistry.getByName("stolen.example.com").claim(
        "someone-else",
        999
      );
      const report = await runInDurableObject(agent(v), (a: TenantAgent) =>
        a.reconcile()
      );
      expect(report.conflicted).toEqual([h.id]);
      expect((await get(v, h.id)).state).toBe("conflict");
    } finally {
      await introspector.dispose();
    }
  });

  it("finishes a delete stuck in deleting once the release works", async () => {
    const v = await visitor();
    const h = await create(v, "stuck.example.com");
    const release = vi
      .spyOn(env.HostnameRegistry.getByName("stuck.example.com"), "release")
      .mockRejectedValueOnce(new Error("registry unavailable"));
    void release;
    await runInDurableObject(agent(v), (_a, state) => {
      state.storage.sql.exec(
        "UPDATE hostnames SET state = 'deleting', updated_at = ? WHERE id = ?",
        Date.now() - LIMITS.verify.deletingStuckMs - 1,
        h.id
      );
    });
    const report = await runInDurableObject(agent(v), (a: TenantAgent) =>
      a.reconcile()
    );
    expect(report.finishedDeletes).toEqual([h.id]);
    expect((await get(v, h.id)).state).toBe("deleted");
  });
});

describe("give up and retry", () => {
  it("fails after the full schedule with no match, and retry starts run 2", async () => {
    const introspector = await skipSleeps();
    try {
      const v = await visitor();
      const h = await create(v, "never.example.com");
      txtByName.set(h.verification.txt_name, ["wrong-token"]);
      const failed = await waitForState(v, h.id, ["failed"], 60_000);
      expect(failed.state).toBe("failed");
      const [instance] = await introspector.get();
      await instance.waitForStatus("complete");
      expect(await instance.getOutput()).toEqual({ outcome: "failed" });
      await instance.waitForStepResult({
        name: `record-${worstCaseSteps().attempts - 1}`
      });

      const retried = await SELF.fetch(
        `${BASE}/api/v1/hostnames/${h.id}/retry`,
        {
          method: "POST",
          headers: { cookie: v.cookie, origin: ORIGIN }
        }
      );
      expect(retried.status).toBe(200);
      expect((await workflowRow(v, h.id)).workflow_run).toBe(2);
      serveToken(h);
      await waitForState(v, h.id, ["active"]);
    } finally {
      await introspector.dispose();
    }
  }, 90_000);
});
