// The daily model turn quota and the per-visitor socket cap, through the real WebSocket
// guard. A turn is taken in SQL before any model call. Sockets are counted from the
// SDK's connections, so the cap holds across hibernation.
import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnLease } from "../src/ai/lease";
import { TurnQuota, secondsUntilReset } from "../src/ai/quota";
import { KILL_SWITCH_MESSAGE } from "../src/ai/turn";
import { LIMITS } from "../src/config/limits";
import { TOO_MANY_SOCKETS_CLOSE } from "../src/config/protocol";
import { migrate } from "../src/hostnames/schema";
import type { TenantAgent } from "../src/server";
import {
  chatFrame,
  connect,
  isError,
  mockModelReply,
  spyOnModel,
  userMessage,
  visitor,
  type Socket,
  type Visitor
} from "./helpers";

afterEach(() => vi.restoreAllMocks());

const LIMIT = LIMITS.chat.turnsPerVisitorPerDay;
const agent = (v: Visitor) => env.TenantAgent.getByName(v.payload.sid);

type Frame = Record<string, unknown>;
const done = (f: Frame) =>
  f.type === "cf_agent_use_chat_response" &&
  (f.done === true || f.error === true);

function send(socket: Socket, text: string) {
  socket.ws.send(
    chatFrame(
      { messages: [userMessage(text)], trigger: "submit-message" },
      crypto.randomUUID()
    )
  );
}

async function setUsed(v: Visitor, used: number) {
  await runInDurableObject(agent(v), (_a, state) => {
    migrate(state.storage);
    state.storage.sql.exec(
      "INSERT INTO turn_quota (day, used) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET used = excluded.used",
      new Date().toISOString().slice(0, 10),
      used
    );
  });
}

const used = (v: Visitor) =>
  runInDurableObject(agent(v), (_a, state) => {
    migrate(state.storage);
    return new TurnQuota(state.storage).used(Date.now());
  });

// Resolves with the close code, or null if the socket is still open after a while.
function closeWithin(socket: Socket, ms = 300) {
  return Promise.race([
    socket.closed.then((c) => c.code),
    new Promise<null>((r) => setTimeout(() => r(null), ms))
  ]);
}

describe("daily turn quota", () => {
  it(`allows ${LIMIT} turns per UTC day, then refuses until midnight`, async () => {
    const v = await visitor();
    await runInDurableObject(agent(v), (_a, state) => {
      migrate(state.storage);
      const quota = new TurnQuota(state.storage);
      const noon = Date.UTC(2026, 9, 6, 12, 0, 0);
      for (let i = 1; i <= LIMIT; i++) {
        expect(quota.take(noon)).toEqual({ ok: true, used: i });
      }
      expect(quota.take(noon)).toEqual({
        ok: false,
        retryAfterSeconds: 12 * 60 * 60
      });
      // A refused take does not count.
      expect(quota.used(noon)).toBe(LIMIT);
      const nextDay = Date.UTC(2026, 9, 7, 0, 0, 1);
      expect(quota.take(nextDay)).toEqual({ ok: true, used: 1 });
      // Earlier days are dropped.
      expect(
        state.storage.sql.exec("SELECT day FROM turn_quota").toArray()
      ).toEqual([{ day: "2026-10-07" }]);
    });
    expect(secondsUntilReset(Date.UTC(2026, 9, 6, 23, 0, 0))).toBe(3600);
  });

  it("sends a 429 error frame with retry_after and never calls the model", async () => {
    const spy = spyOnModel();
    const v = await visitor();
    await setUsed(v, LIMIT);
    const socket = await connect(v.cookie);
    send(socket, "hello");
    const frame = await socket.next(isError(429));
    expect(frame.title).toBe("daily chat limit reached");
    expect(frame.retry_after).toBeGreaterThan(0);
    expect(frame.retry_after).toBeLessThanOrEqual(24 * 60 * 60);
    expect(spy).not.toHaveBeenCalled();
    // The lease was given back, and the socket stays open for the hostname table.
    const holder = await runInDurableObject(agent(v), (_a, state) =>
      new TurnLease(state.storage).holder(Date.now())
    );
    expect(holder).toBeNull();
    expect(await closeWithin(socket)).toBeNull();
    socket.ws.close();
  });

  it("is shared by all of a visitor's sockets", async () => {
    const spy = spyOnModel().mockImplementation(() => mockModelReply("Hi."));
    const v = await visitor();
    await setUsed(v, LIMIT - 1);
    const a = await connect(v.cookie);
    const b = await connect(v.cookie);
    send(a, "first");
    await a.next(done);
    send(b, "second");
    await b.next(isError(429));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await used(v)).toBe(LIMIT);
    a.ws.close();
    b.ws.close();
  });

  it("does not use a turn when the reply is refused for an overlapping turn", async () => {
    const spy = spyOnModel();
    const v = await visitor();
    await runInDurableObject(agent(v), (_a, state) => {
      migrate(state.storage);
      new TurnLease(state.storage).acquire("someone-else", Date.now());
    });
    const socket = await connect(v.cookie);
    send(socket, "hello");
    await socket.next(isError(409));
    expect(await used(v)).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    socket.ws.close();
  });

  it("does not use a turn while the kill switch is on", async () => {
    const spy = spyOnModel();
    const v = await visitor();
    await setUsed(v, LIMIT);
    await runInDurableObject(agent(v), (a: TenantAgent) => {
      // Only this agent instance sees the change.
      const target = a as unknown as { env: Record<string, unknown> };
      target.env = { ...target.env, AI_KILL_SWITCH: "true" };
    });
    const socket = await connect(v.cookie);
    send(socket, "hello");
    await socket.next(done);
    const text = await runInDurableObject(agent(v), (a: TenantAgent) =>
      JSON.stringify(a.messages.at(-1)?.parts)
    );
    expect(text).toContain(KILL_SWITCH_MESSAGE);
    expect(await used(v)).toBe(LIMIT);
    expect(spy).not.toHaveBeenCalled();
    socket.ws.close();
  });
});

describe("socket cap", () => {
  const MAX = LIMITS.ws.maxSocketsPerVisitor;

  async function open(v: Visitor, n: number) {
    const sockets: Socket[] = [];
    for (let i = 0; i < n; i++) sockets.push(await connect(v.cookie));
    return sockets;
  }

  it(`accepts ${MAX} sockets, then closes the next with 4429`, async () => {
    const v = await visitor();
    const sockets = await open(v, MAX);
    const extra = await connect(v.cookie);
    expect(await extra.closed).toEqual({
      code: TOO_MANY_SOCKETS_CLOSE,
      reason: "too many open tabs"
    });
    for (const s of sockets) expect(await closeWithin(s, 50)).toBeNull();

    // Closing one frees a place.
    sockets[0].ws.close();
    await new Promise((r) => setTimeout(r, 200));
    const again = await connect(v.cookie);
    expect(await closeWithin(again)).toBeNull();
    for (const s of [...sockets.slice(1), again]) s.ws.close();
  });

  it("counts sockets that survived hibernation", async () => {
    const v = await visitor();
    const sockets = await open(v, MAX);
    await evictDurableObject(agent(v));
    const extra = await connect(v.cookie);
    expect((await extra.closed).code).toBe(TOO_MANY_SOCKETS_CLOSE);
    for (const s of sockets) s.ws.close();
  });

  it("gives other visitors their own allowance", async () => {
    const alice = await visitor();
    const bob = await visitor();
    const aliceSockets = await open(alice, MAX);
    const bobSocket = await connect(bob.cookie);
    expect(await closeWithin(bobSocket)).toBeNull();
    for (const s of [...aliceSockets, bobSocket]) s.ws.close();
  });
});
