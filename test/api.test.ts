// REST v1 through the real Worker: cookie, origin, schemas, ETags, idempotency, paging.
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { LIMITS } from "../src/config/limits";
import wranglerConfig from "../wrangler.jsonc?raw";
import {
  BASE,
  ORIGIN,
  chatFrame,
  connect,
  isError,
  spyOnModel,
  visitor,
  type Visitor
} from "./helpers";

const URL_ = `${BASE}/api/v1/hostnames`;

let keySeq = 0;
function post(v: Visitor, body: unknown, headers: Record<string, string> = {}) {
  return SELF.fetch(URL_, {
    method: "POST",
    headers: {
      cookie: v.cookie,
      origin: ORIGIN,
      "content-type": "application/json",
      "idempotency-key": `key-${keySeq++}`,
      ...headers
    },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}

const get = (v: Visitor, path = "", headers: Record<string, string> = {}) =>
  SELF.fetch(`${URL_}${path}`, { headers: { cookie: v.cookie, ...headers } });

const send = (
  v: Visitor,
  method: string,
  path: string,
  headers: Record<string, string> = {}
) =>
  SELF.fetch(`${URL_}${path}`, {
    method,
    headers: { cookie: v.cookie, origin: ORIGIN, ...headers }
  });

type View = {
  id: string;
  etag: string;
  state: string;
  hostname: string;
  display_hostname: string;
};

async function create(v: Visitor, hostname: string): Promise<View> {
  const res = await post(v, { hostname });
  expect(res.status).toBe(201);
  return res.json();
}

async function problemOf(res: Response, status: number) {
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type")).toBe("application/problem+json");
  return (await res.json()) as { type: string; detail?: string };
}

describe("POST /api/v1/hostnames", () => {
  it("creates a hostname with Location and ETag", async () => {
    const v = await visitor();
    const res = await post(v, { hostname: "Shop.Bücher.de." });
    expect(res.status).toBe(201);
    const body = (await res.json()) as View;
    expect(body).toMatchObject({
      hostname: "shop.xn--bcher-kva.de",
      display_hostname: "shop.bücher.de",
      state: "pending"
    });
    expect(res.headers.get("location")).toBe(`/api/v1/hostnames/${body.id}`);
    expect(res.headers.get("etag")).toBe(body.etag);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("replays the same key and body, and refuses the same key with another body", async () => {
    const v = await visitor();
    const headers = { "idempotency-key": "order-42" };
    const first = await post(v, { hostname: "idem.example.com" }, headers);
    const again = await post(v, { hostname: "idem.example.com" }, headers);
    expect(again.status).toBe(201);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(((await again.json()) as View).id).toBe(
      ((await first.json()) as View).id
    );
    const reuse = await post(v, { hostname: "other.example.com" }, headers);
    expect((await problemOf(reuse, 422)).type).toBe(
      "/problems/idempotency-key-reuse"
    );
  });

  it("requires an Idempotency-Key", async () => {
    const v = await visitor();
    const res = await SELF.fetch(URL_, {
      method: "POST",
      headers: {
        cookie: v.cookie,
        origin: ORIGIN,
        "content-type": "application/json"
      },
      body: JSON.stringify({ hostname: "a.example.com" })
    });
    await problemOf(res, 428);
  });

  it("rejects a malformed Idempotency-Key", async () => {
    const v = await visitor();
    await problemOf(
      await post(
        v,
        { hostname: "a.example.com" },
        { "idempotency-key": "has space" }
      ),
      400
    );
  });

  it("rejects bad bodies with 400", async () => {
    const v = await visitor();
    await problemOf(await post(v, "{not json"), 400);
    await problemOf(
      await post(v, { hostname: "a.example.com", admin: true }),
      400
    );
    await problemOf(await post(v, { hostname: 7 }), 400);
    await problemOf(
      await post(
        v,
        { hostname: "a.example.com" },
        { "content-type": "text/plain" }
      ),
      400
    );
  });

  it("explains an invalid hostname with a fixed message", async () => {
    const v = await visitor();
    const problem = await problemOf(
      await post(v, { hostname: "*.example.com" }),
      400
    );
    expect(problem).toMatchObject({
      type: "/problems/invalid-hostname",
      detail: "Wildcard hostnames are not supported."
    });
  });

  it("returns 409 for a hostname that is already live", async () => {
    const v = await visitor();
    await create(v, "dup.example.com");
    expect(
      (await problemOf(await post(v, { hostname: "DUP.example.com" }), 409))
        .type
    ).toBe("/problems/hostname-exists");
  });

  it("returns 413 for a body over the cap even without Content-Length", async () => {
    const v = await visitor();
    const big = new ReadableStream({
      start(c) {
        c.enqueue(
          new TextEncoder().encode(
            `{"hostname":"${"a".repeat(LIMITS.http.maxBodyBytes)}"}`
          )
        );
        c.close();
      }
    });
    const res = await SELF.fetch(URL_, {
      method: "POST",
      headers: {
        cookie: v.cookie,
        origin: ORIGIN,
        "content-type": "application/json",
        "idempotency-key": "big"
      },
      body: big,
      // @ts-expect-error duplex is required for streaming bodies
      duplex: "half"
    });
    await problemOf(res, 413);
  });

  it("needs the cookie and the origin", async () => {
    const v = await visitor();
    const noCookie = await SELF.fetch(URL_, {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "idempotency-key": "x"
      },
      body: "{}"
    });
    await problemOf(noCookie, 401);
    await problemOf(
      await post(
        v,
        { hostname: "a.example.com" },
        { origin: "https://evil.example" }
      ),
      403
    );
    await problemOf(await get({ ...v, cookie: "" }), 401);
  });
});

describe("GET, DELETE and retry", () => {
  it("serves ETag and honours If-None-Match", async () => {
    const v = await visitor();
    const h = await create(v, "etag.example.com");
    const res = await get(v, `/${h.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe(h.etag);
    const cached = await get(v, `/${h.id}`, { "if-none-match": h.etag });
    expect(cached.status).toBe(304);
  });

  it("requires If-Match to delete and refuses a stale one", async () => {
    const v = await visitor();
    const h = await create(v, "del.example.com");
    await problemOf(await send(v, "DELETE", `/${h.id}`), 428);
    await problemOf(
      await send(v, "DELETE", `/${h.id}`, { "if-match": `"${h.id}.2"` }),
      412
    );
    const ok = await send(v, "DELETE", `/${h.id}`, { "if-match": h.etag });
    expect(ok.status).toBe(202);
    expect(((await ok.json()) as View).state).toBe("deleted");
    const list = (await (await get(v)).json()) as { items: View[] };
    expect(list.items.map((i) => i.id)).not.toContain(h.id);
  });

  it("refuses retry from pending with 409", async () => {
    const v = await visitor();
    const h = await create(v, "retry.example.com");
    const problem = await problemOf(
      await send(v, "POST", `/${h.id}/retry`),
      409
    );
    expect(problem.type).toBe("/problems/invalid-transition");
  });

  it("lists the creation and delete events", async () => {
    const v = await visitor();
    const h = await create(v, "events.example.com");
    await send(v, "DELETE", `/${h.id}`, { "if-match": h.etag });
    const res = await get(v, `/${h.id}/events`);
    const body = (await res.json()) as {
      items: { to_state: string; actor: string }[];
    };
    expect(body.items.map((e) => `${e.to_state}:${e.actor}`)).toEqual([
      "pending:user",
      "deleting:user",
      "deleted:system"
    ]);
  });

  it("answers another visitor's hostname with a plain 404 everywhere", async () => {
    const alice = await visitor();
    const bob = await visitor();
    const h = await create(alice, "alice.example.com");
    await problemOf(await get(bob, `/${h.id}`), 404);
    await problemOf(await get(bob, `/${h.id}/events`), 404);
    await problemOf(
      await send(bob, "DELETE", `/${h.id}`, { "if-match": h.etag }),
      404
    );
    await problemOf(await send(bob, "POST", `/${h.id}/retry`), 404);
    const list = (await (await get(bob)).json()) as { items: View[] };
    expect(list.items).toEqual([]);
  });

  it("rejects unknown query parameters, bad limits and forged cursors", async () => {
    const v = await visitor();
    await problemOf(await get(v, "?limit=0"), 400);
    await problemOf(await get(v, "?limit=abc"), 400);
    await problemOf(await get(v, "?sort=asc"), 400);
    expect((await problemOf(await get(v, "?cursor=abc"), 400)).type).toBe(
      "/problems/invalid-cursor"
    );
    expect((await get(v, "?limit=500")).status).toBe(200);
  });

  it("returns 405 and 404 for unsupported shapes", async () => {
    const v = await visitor();
    await problemOf(await send(v, "PUT", ""), 405);
    await problemOf(await get(v, "/hn_000000000000000000000000/nope"), 404);
  });
});

describe("rate limit", () => {
  it("returns 429 past the per-visitor API limit", async () => {
    const v = await visitor();
    for (let i = 0; i < LIMITS.rateLimits.apiPerVisitor.limit; i++) {
      expect((await get(v)).status).toBe(200);
    }
    await problemOf(await get(v), 429);
  });
});

describe("callables over the WebSocket", () => {
  it("confirmDelete and retryHostname go through the same service", async () => {
    const spy = spyOnModel();
    const v = await visitor();
    const h = await create(v, "callable.example.com");
    const socket = await connect(v.cookie);

    socket.ws.send(
      JSON.stringify({
        type: "rpc",
        id: "r1",
        method: "retryHostname",
        args: [h.id]
      })
    );
    const retried = await socket.next((f) => f.type === "rpc" && f.id === "r1");
    expect(retried).toMatchObject({
      success: true,
      result: { ok: false, error: "invalid-transition" }
    });

    socket.ws.send(
      JSON.stringify({
        type: "rpc",
        id: "r2",
        method: "confirmDelete",
        args: [h.id, `"${h.id}.9"`]
      })
    );
    const stale = await socket.next((f) => f.type === "rpc" && f.id === "r2");
    expect(stale).toMatchObject({
      result: { ok: false, error: "precondition-failed" }
    });

    socket.ws.send(
      JSON.stringify({
        type: "rpc",
        id: "r3",
        method: "confirmDelete",
        args: [h.id, h.etag]
      })
    );
    const deleted = await socket.next((f) => f.type === "rpc" && f.id === "r3");
    expect(deleted).toMatchObject({
      result: { ok: true, hostname: { state: "deleted" } }
    });
    expect(spy).not.toHaveBeenCalled();
    socket.ws.close();
  });

  it("rejects callables with the wrong arguments", async () => {
    const v = await visitor();
    const socket = await connect(v.cookie);
    socket.ws.send(
      JSON.stringify({
        type: "rpc",
        id: "r1",
        method: "confirmDelete",
        args: ["only-one"]
      })
    );
    await socket.next(isError(400));
    socket.ws.send(
      JSON.stringify({
        type: "rpc",
        id: "r2",
        method: "retryHostname",
        args: [{ id: 1 }]
      })
    );
    await socket.next(isError(400));
    socket.ws.send(
      JSON.stringify({
        type: "rpc",
        id: "r3",
        method: "apiDelete",
        args: ["x", "y"]
      })
    );
    await socket.next(isError(403));
    socket.ws.send(chatFrame({ messages: [], trigger: "submit-message" }));
    await socket.next(isError(400));
    socket.ws.close();
  });
});

describe("production config", () => {
  it("trusts only the workers.dev origin", () => {
    const config = JSON.parse(wranglerConfig) as {
      vars: { ALLOWED_ORIGINS: string };
    };
    expect(config.vars.ALLOWED_ORIGINS).toBe(
      "https://hostname-doctor.bhatnagarashwabh.workers.dev"
    );
  });
});

describe("service zone", () => {
  it("refuses FALLBACK_ORIGIN and names under it as custom hostnames", async () => {
    const v = await visitor();
    for (const hostname of [
      "hostname-doctor.bhatnagarashwabh.workers.dev",
      "shop.hostname-doctor.bhatnagarashwabh.workers.dev"
    ]) {
      const res = await post(v, { hostname });
      const body = (await problemOf(res, 400)) as { detail?: string };
      expect(body.detail).toContain("belongs to the service");
    }
  });
});
