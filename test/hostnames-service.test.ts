// HostnameService against real Durable Object SQLite, with a controllable clock and
// registry so expiry and the await race can be exercised.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { LIMITS } from "../src/config/limits";
import { migrate } from "../src/hostnames/schema";
import {
  HostnameService,
  type CreateInput,
  type HostnameView
} from "../src/hostnames/service";
import {
  ACTORS,
  STATES,
  isAllowed,
  type HostnameState
} from "../src/hostnames/state-machine";

type Harness = {
  service: HostnameService;
  storage: DurableObjectStorage;
  clock: { now: number };
};

async function withService<T>(
  fn: (h: Harness) => T | Promise<T>,
  registerDelayMs = 0
): Promise<T> {
  const stub = env.TenantAgent.getByName(`svc-${crypto.randomUUID()}`);
  return runInDurableObject(stub, async (_agent, state) => {
    migrate(state.storage);
    const clock = { now: Date.UTC(2026, 9, 6) };
    let generation = 1;
    const service = new HostnameService(state.storage, {
      register: async () => {
        if (registerDelayMs)
          await new Promise((r) => setTimeout(r, registerDelayMs));
        return generation++;
      },
      now: () => clock.now
    });
    return fn({ service, storage: state.storage, clock });
  });
}

let keySeq = 0;
function input(hostname: string, over: Partial<CreateInput> = {}): CreateInput {
  return {
    hostname,
    idempotencyKey: `k-${keySeq++}`,
    requestHash: `h-${hostname}`,
    actor: "user",
    ...over
  };
}

async function created(
  service: HostnameService,
  hostname: string
): Promise<HostnameView> {
  const result = await service.create(input(hostname));
  if (!result.ok) throw new Error(`create failed: ${result.error}`);
  return result.hostname;
}

function seed(storage: DurableObjectStorage, state: HostnameState, n: number) {
  const id = `hn_${n.toString(16).padStart(24, "0")}`;
  storage.sql.exec(
    `INSERT INTO hostnames (id, hostname, generation, state, version, verify_token, created_at, updated_at)
     VALUES (?, ?, 7, ?, 3, 'tok', ?, ?)`,
    id,
    `h${n}.example.com`,
    state,
    1000 + n,
    1000 + n
  );
  return id;
}

function events(storage: DurableObjectStorage, id: string) {
  return storage.sql
    .exec<{ from_state: string | null; to_state: string; actor: string }>(
      "SELECT from_state, to_state, actor FROM events WHERE hostname_id = ? ORDER BY id",
      id
    )
    .toArray();
}

describe("transition() against SQLite", () => {
  it("allows exactly the section 2 transitions and writes row plus event together", async () => {
    await withService(({ service, storage }) => {
      let n = 1;
      let allowed = 0;
      for (const from of STATES) {
        for (const to of STATES) {
          for (const actor of ACTORS) {
            const id = seed(storage, from, n++);
            const result = service.transition(id, to, actor, {
              generation: 7,
              version: 3
            });
            const row = storage.sql
              .exec<{ state: string; version: number }>(
                "SELECT state, version FROM hostnames WHERE id = ?",
                id
              )
              .one();
            if (isAllowed(from, to, actor)) {
              allowed++;
              expect(result.ok, `${from}->${to} by ${actor}`).toBe(true);
              expect(row).toEqual({ state: to, version: 4 });
              expect(events(storage, id)).toEqual([
                { from_state: from, to_state: to, actor }
              ]);
            } else {
              expect(result, `${from}->${to} by ${actor}`).toEqual({
                ok: false,
                error: "invalid-transition"
              });
              expect(row).toEqual({ state: from, version: 3 });
              expect(events(storage, id)).toEqual([]);
            }
          }
        }
      }
      expect(allowed).toBe(16);
    });
  });

  it("refuses a stale version without writing", async () => {
    await withService(({ service, storage }) => {
      const id = seed(storage, "pending", 1);
      expect(
        service.transition(id, "verified", "system", {
          generation: 7,
          version: 2
        })
      ).toEqual({
        ok: false,
        error: "precondition-failed",
        detail: "version"
      });
      expect(events(storage, id)).toEqual([]);
    });
  });

  it("refuses a stale generation without writing", async () => {
    await withService(({ service, storage }) => {
      const id = seed(storage, "pending", 1);
      expect(
        service.transition(id, "verified", "system", {
          generation: 6,
          version: 3
        })
      ).toEqual({
        ok: false,
        error: "precondition-failed",
        detail: "generation"
      });
      expect(events(storage, id)).toEqual([]);
    });
  });

  it("refuses the second of two writers holding the same version", async () => {
    await withService(({ service, storage }) => {
      const id = seed(storage, "pending", 1);
      const expected = { generation: 7, version: 3 };
      expect(service.transition(id, "failed", "system", expected).ok).toBe(
        true
      );
      expect(
        service.transition(id, "verified", "system", expected)
      ).toMatchObject({
        ok: false,
        error: "precondition-failed"
      });
    });
  });
});

describe("create", () => {
  it("stores punycode, shows unicode, and records the creation event", async () => {
    await withService(async ({ service, storage }) => {
      const view = await created(service, "Bücher.de.");
      expect(view).toMatchObject({
        hostname: "xn--bcher-kva.de",
        display_hostname: "bücher.de",
        state: "pending",
        version: 1,
        generation: 1,
        etag: `"${view.id}.1"`,
        verification: { txt_name: "_cf-custom-hostname.xn--bcher-kva.de" }
      });
      expect(events(storage, view.id)).toEqual([
        { from_state: null, to_state: "pending", actor: "user" }
      ]);
    });
  });

  it("refuses system as a creator", async () => {
    await withService(async ({ service }) => {
      expect(
        await service.create(input("a.example.com", { actor: "system" }))
      ).toMatchObject({
        ok: false,
        error: "invalid-transition"
      });
    });
  });

  it("re-checks at commit, so two racing creates of one hostname make one row", async () => {
    await withService(async ({ service, storage }) => {
      const [a, b] = await Promise.all([
        service.create(input("race.example.com")),
        service.create(input("race.example.com"))
      ]);
      expect([a.ok, b.ok].sort()).toEqual([false, true]);
      expect([a, b].find((r) => !r.ok)).toMatchObject({
        error: "hostname-exists"
      });
      expect(
        storage.sql
          .exec<{ n: number }>("SELECT COUNT(*) AS n FROM hostnames")
          .one().n
      ).toBe(1);
    }, 5);
  });

  it("stops at 25 live hostnames, also when creates race past the early check", async () => {
    await withService(async ({ service }) => {
      for (let i = 0; i < LIMITS.hostnames.maxPerVisitor - 1; i++) {
        await created(service, `q${i}.example.com`);
      }
      const [a, b] = await Promise.all([
        service.create(input("last-a.example.com")),
        service.create(input("last-b.example.com"))
      ]);
      expect([a, b].filter((r) => r.ok)).toHaveLength(1);
      expect([a, b].find((r) => !r.ok)).toMatchObject({
        error: "quota-exceeded"
      });
    }, 5);
  });

  it("frees a quota slot once a hostname is deleted", async () => {
    await withService(async ({ service }) => {
      const views: HostnameView[] = [];
      for (let i = 0; i < LIMITS.hostnames.maxPerVisitor; i++) {
        views.push(await created(service, `f${i}.example.com`));
      }
      expect(await service.create(input("extra.example.com"))).toMatchObject({
        error: "quota-exceeded"
      });
      expect(service.delete(views[0].id, views[0].etag, "user").ok).toBe(true);
      expect((await service.create(input("extra.example.com"))).ok).toBe(true);
    });
  });

  it("rejects a hostname that is already live, and allows it again after delete with a new generation", async () => {
    await withService(async ({ service }) => {
      const first = await created(service, "again.example.com");
      expect(await service.create(input("AGAIN.example.com."))).toMatchObject({
        error: "hostname-exists"
      });
      service.delete(first.id, first.etag, "user");
      const second = await created(service, "again.example.com");
      expect(second.generation).toBeGreaterThan(first.generation);
      expect(second.id).not.toBe(first.id);
    });
  });
});

describe("idempotency", () => {
  it("replays the same key with the same body", async () => {
    await withService(async ({ service, storage }) => {
      const req = input("idem.example.com");
      const first = await service.create(req);
      const second = await service.create(req);
      expect(first).toMatchObject({ ok: true, replayed: false });
      expect(second).toMatchObject({ ok: true, replayed: true });
      if (!first.ok || !second.ok) throw new Error("unexpected");
      expect(second.hostname).toEqual(first.hostname);
      expect(
        storage.sql
          .exec<{ n: number }>("SELECT COUNT(*) AS n FROM hostnames")
          .one().n
      ).toBe(1);
    });
  });

  it("refuses the same key with a different body", async () => {
    await withService(async ({ service }) => {
      await service.create(
        input("one.example.com", { idempotencyKey: "same" })
      );
      expect(
        await service.create(
          input("two.example.com", { idempotencyKey: "same" })
        )
      ).toEqual({ ok: false, error: "idempotency-key-reuse" });
    });
  });

  it("forgets keys after 24 hours", async () => {
    await withService(async ({ service, clock }) => {
      const first = await service.create(
        input("ttl.example.com", { idempotencyKey: "ttl" })
      );
      if (!first.ok) throw new Error("unexpected");
      service.delete(first.hostname.id, first.hostname.etag, "user");
      clock.now += LIMITS.idempotency.ttlSeconds * 1000 + 1;
      const again = await service.create(
        input("ttl.example.com", { idempotencyKey: "ttl" })
      );
      expect(again).toMatchObject({ ok: true, replayed: false });
    });
  });

  it("keeps at most 500 keys and evicts the oldest", async () => {
    await withService(async ({ service, storage, clock }) => {
      for (let i = 0; i < LIMITS.idempotency.maxRows; i++) {
        storage.sql.exec(
          "INSERT INTO idempotency_keys (key, request_hash, status, response_json, created_at) VALUES (?, 'h', 201, '{}', ?)",
          `old-${i}`,
          clock.now - 1000 + i
        );
      }
      await created(service, "cap.example.com");
      const keys = storage.sql
        .exec<{ key: string }>("SELECT key FROM idempotency_keys")
        .toArray();
      expect(keys).toHaveLength(LIMITS.idempotency.maxRows);
      expect(keys.some((k) => k.key === "old-0")).toBe(false);
    });
  });
});

describe("paging", () => {
  it("stays stable while rows are added and removed between pages", async () => {
    await withService(async ({ service }) => {
      const original: string[] = [];
      for (let i = 0; i < 7; i++)
        original.unshift((await created(service, `p${i}.example.com`)).id);

      const page1 = service.list({ limit: 3 });
      if (!page1.ok) throw new Error("unexpected");
      expect(page1.page.items.map((h) => h.id)).toEqual(original.slice(0, 3));

      // New rows arrive and one already-seen row is deleted mid-scan.
      await created(service, "late1.example.com");
      await created(service, "late2.example.com");
      const seen = page1.page.items[0];
      service.delete(seen.id, seen.etag, "user");

      const seenIds = [...page1.page.items.map((h) => h.id)];
      let cursor = page1.page.next_cursor;
      while (cursor) {
        const page = service.list({ limit: 3, cursor });
        if (!page.ok) throw new Error("unexpected");
        seenIds.push(...page.page.items.map((h) => h.id));
        cursor = page.page.next_cursor;
      }
      // Every original row exactly once, in order. The late rows only show on a new first page.
      expect(seenIds).toEqual(original);
      const fresh = service.list({ limit: 3 });
      if (!fresh.ok) throw new Error("unexpected");
      expect(fresh.page.items.map((h) => h.hostname).slice(0, 2)).toEqual([
        "late2.example.com",
        "late1.example.com"
      ]);
    });
  });

  it("caps the page size at 50 and defaults to 20", async () => {
    await withService(async ({ service }) => {
      for (let i = 0; i < LIMITS.hostnames.maxPerVisitor; i++) {
        await created(service, `c${i}.example.com`);
      }
      const def = service.list({});
      const big = service.list({ limit: 500 });
      if (!def.ok || !big.ok) throw new Error("unexpected");
      expect(def.page.items).toHaveLength(LIMITS.paging.defaultLimit);
      expect(big.page.items).toHaveLength(LIMITS.hostnames.maxPerVisitor);
      expect(LIMITS.paging.maxLimit).toBe(50);
    });
  });

  it("rejects a forged cursor", async () => {
    await withService(({ service }) => {
      for (const cursor of [
        "!!",
        btoa('{"c":1}'),
        btoa('{"c":1,"i":"x","z":1}')
      ]) {
        expect(service.list({ cursor })).toEqual({
          ok: false,
          error: "invalid-cursor"
        });
      }
    });
  });

  it("pages events in order", async () => {
    await withService(async ({ service }) => {
      const h = await created(service, "ev.example.com");
      service.delete(h.id, h.etag, "user");
      const first = service.events(h.id, { limit: 2 });
      if (!first.ok || !first.page.next_cursor) throw new Error("unexpected");
      const second = service.events(h.id, {
        limit: 2,
        cursor: first.page.next_cursor
      });
      if (!second.ok) throw new Error("unexpected");
      expect(
        [...first.page.items, ...second.page.items].map((e) => [
          e.to_state,
          e.actor
        ])
      ).toEqual([
        ["pending", "user"],
        ["deleting", "user"],
        ["deleted", "system"]
      ]);
    });
  });
});

describe("retry and delete", () => {
  it("retries only from failed or conflict", async () => {
    await withService(({ service, storage }) => {
      expect(service.retry(seed(storage, "pending", 1), "user")).toMatchObject({
        error: "invalid-transition"
      });
      expect(service.retry(seed(storage, "failed", 2), "user")).toMatchObject({
        ok: true,
        hostname: { state: "pending" }
      });
      expect(
        service.retry(seed(storage, "conflict", 3), "model")
      ).toMatchObject({ ok: true });
    });
  });

  it("deletes only with the current ETag", async () => {
    await withService(async ({ service }) => {
      const h = await created(service, "del.example.com");
      expect(service.delete(h.id, `"${h.id}.9"`, "user")).toMatchObject({
        error: "precondition-failed"
      });
      expect(service.delete(h.id, "*", "user")).toMatchObject({
        error: "precondition-failed"
      });
      expect(service.delete(h.id, h.etag, "model")).toMatchObject({
        error: "invalid-transition"
      });
      expect(service.delete(h.id, h.etag, "user")).toMatchObject({
        ok: true,
        hostname: { state: "deleted", version: 3 }
      });
    });
  });

  it("treats unknown and malformed ids as not found", async () => {
    await withService(({ service }) => {
      for (const id of ["hn_000000000000000000000000", "nope", "' OR 1=1 --"]) {
        expect(service.get(id)).toEqual({ ok: false, error: "not-found" });
        expect(service.retry(id, "user")).toEqual({
          ok: false,
          error: "not-found"
        });
      }
    });
  });
});

describe("migrations", () => {
  it("are forward only and safe to run again", async () => {
    await withService(({ storage }) => {
      migrate(storage);
      const versions = storage.sql
        .exec<{ version: number }>(
          "SELECT version FROM hd_schema_migrations ORDER BY version"
        )
        .toArray();
      expect(versions.map((v) => v.version)).toEqual([1, 2, 3]);
    });
  });
});
