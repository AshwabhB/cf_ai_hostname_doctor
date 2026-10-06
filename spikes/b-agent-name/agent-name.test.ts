import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const base = "https://spike.test/agents/probe-agent";

function get(path: string, visitor: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("x-spike-visitor", visitor);
  return SELF.fetch(`${base}/${path}`, { ...init, headers });
}

const upgrade = { headers: { Upgrade: "websocket" } };

describe("spike B: rewrite strategy", () => {
  it("routes to the visitor's agent even when the URL names another", async () => {
    const res = await get("bob?mode=rewrite", "alice");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("alice");
  });

  it("also rewrites WebSocket upgrades", async () => {
    const res = await get("bob?mode=rewrite", "alice", upgrade);
    expect(res.status).toBe(101);
    res.webSocket?.accept();
    res.webSocket?.close();
  });
});

describe("spike B: guard strategy with onBeforeRequest and onBeforeConnect", () => {
  it("rejects an HTTP request for another visitor's agent", async () => {
    const res = await get("bob", "alice");
    expect(res.status).toBe(403);
  });

  it("rejects a WebSocket upgrade for another visitor's agent", async () => {
    const res = await get("bob", "alice", upgrade);
    expect(res.status).toBe(403);
  });

  it("allows the visitor's own agent", async () => {
    const res = await get("alice", "alice");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("alice");
  });
});

describe("spike B: no visitor", () => {
  it("returns 401 before routing", async () => {
    const res = await SELF.fetch(`${base}/alice`);
    expect(res.status).toBe(401);
  });
});
