// Structured logs: the redaction helper on its own, then the lines a real chat turn and
// a REST call produce. No line may carry prompts, model text, cookies, sids or TXT values.
import { SELF, env, runInDurableObject } from "cloudflare:test";
import type { LanguageModel } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIMITS } from "../src/config/limits";
import { redact, visitorHash } from "../src/observability/log";
import type { TenantAgent } from "../src/server";
import {
  BASE,
  ORIGIN,
  chatFrame,
  connect,
  spyOnModel,
  userMessage,
  visitor,
  type Visitor
} from "./helpers";
import { scriptedModel } from "./mock-model";

type Line = Record<string, unknown>;

const ALLOWED = new Set([
  "event",
  "visitor",
  "hostname_id",
  "outcome",
  "latency_ms",
  "correlation_id",
  "from_state",
  "to_state",
  "actor",
  "tool",
  "step",
  "attempt",
  "steps",
  "first_token_ms",
  "error",
  "lookups",
  "findings",
  "method",
  "route",
  "status"
]);

let raw: string[] = [];
beforeEach(() => {
  raw = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    raw.push(args.map(String).join(" "));
  });
});
afterEach(() => vi.restoreAllMocks());

// Our structured lines, parsed. Anything else on stdout is not ours.
function lines(): Line[] {
  return raw
    .filter((l) => l.startsWith('{"'))
    .map((l) => JSON.parse(l) as Line)
    .filter((l) => typeof l.event === "string");
}

function expectClean(forbidden: string[]) {
  for (const l of raw.filter((r) => r.startsWith('{"'))) {
    for (const secret of forbidden) expect(l).not.toContain(secret);
  }
  for (const l of lines()) {
    for (const key of Object.keys(l)) expect(ALLOWED.has(key)).toBe(true);
  }
}

describe("redaction helper", () => {
  it("keeps only allowlisted keys and scalar values", () => {
    expect(
      redact({
        event: "tool_call",
        tool: "add_hostname",
        latency_ms: 12,
        prompt: "system prompt text",
        text: "model reply",
        cookie: "__Host-hd_sid=abc",
        nested: { a: 1 },
        error: new Error("boom")
      })
    ).toEqual({ event: "tool_call", tool: "add_hostname", latency_ms: 12 });
  });

  it("masks hex runs of 32 or more, long opaque strings and credential text", () => {
    const token = "2d170a7e39af14e34b49c854280f6dd0";
    const signed = `eyJ2IjoxLCJzaWQiOiJhYmMifQ.${"A".repeat(43)}`;
    const out = redact({
      outcome: `found ${token} here`,
      step: signed,
      error: "Bearer abc",
      route: "cookie: x=y"
    });
    expect(out.outcome).toBe("found [redacted] here");
    expect(out.step).not.toContain("A".repeat(43));
    expect(out.error).toBe("[redacted]");
    expect(out.route).toBe("[redacted]");
  });

  it("keeps hostname ids and UUIDs readable, cuts long strings and lists", () => {
    const id = "hn_0123456789abcdef01234567";
    const uuid = crypto.randomUUID();
    const out = redact({
      hostname_id: id,
      correlation_id: uuid,
      outcome: "word ".repeat(100),
      findings: Array.from({ length: 50 }, (_, i) => `CODE_${i}`)
    });
    expect(out.hostname_id).toBe(id);
    expect(out.correlation_id).toBe(uuid);
    expect(out.outcome).toHaveLength(LIMITS.logs.maxStringChars);
    expect(out.findings).toHaveLength(LIMITS.logs.maxListItems);
  });

  it("hashes the visitor id with the secret, short and stable", async () => {
    const sid = "0123456789abcdef0123456789abcdef";
    const a = await visitorHash("secret-one", sid);
    expect(a).toMatch(
      new RegExp(`^[0-9a-f]{${LIMITS.logs.visitorHashChars}}$`)
    );
    expect(await visitorHash("secret-one", sid)).toBe(a);
    expect(await visitorHash("secret-two", sid)).not.toBe(a);
    expect(sid).not.toContain(a);
  });
});

async function createHostname(v: Visitor, hostname: string) {
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
  return (await res.json()) as {
    id: string;
    verification: { txt_value: string };
  };
}

describe("log lines", () => {
  it("a REST create logs api_request and its transition under one correlation id", async () => {
    const v = await visitor();
    const h = await createHostname(v, "logs-rest.example.com");
    await SELF.fetch(`${BASE}/api/v1/hostnames/${h.id}`, {
      headers: { cookie: v.cookie }
    });

    const hashed = await visitorHash(env.SESSION_SECRET, v.payload.sid);
    const [create, get] = lines().filter((l) => l.event === "api_request");
    expect(create).toMatchObject({
      method: "POST",
      route: "/api/v1/hostnames",
      status: 201,
      outcome: "ok",
      visitor: hashed
    });
    expect(get).toMatchObject({ route: "/api/v1/hostnames/:id", status: 200 });
    expect(get.correlation_id).not.toBe(create.correlation_id);
    const transition = lines().find((l) => l.event === "transition");
    expect(transition).toMatchObject({
      hostname_id: h.id,
      from_state: null,
      to_state: "pending",
      actor: "user",
      visitor: hashed,
      correlation_id: create.correlation_id
    });
    expectClean([
      v.payload.sid,
      v.cookie.split("=")[1],
      h.verification.txt_value
    ]);
  });

  it("a chat turn logs model_call, tool_call and the transition, without its text", async () => {
    const v = await visitor();
    const model = scriptedModel([
      {
        kind: "tools",
        calls: [
          { name: "add_hostname", input: { hostname: "logs-chat.example.com" } }
        ]
      },
      { kind: "text", text: "MODEL-REPLY-MARKER added it for you." }
    ]);
    spyOnModel().mockImplementation(() => model as unknown as LanguageModel);
    const socket = await connect(v.cookie);
    socket.ws.send(
      chatFrame(
        {
          messages: [userMessage("USER-TEXT-MARKER add logs-chat.example.com")],
          trigger: "submit-message"
        },
        "client-chosen-request-id"
      )
    );
    await socket.next(
      (f) => f.type === "cf_agent_use_chat_response" && f.done === true
    );
    socket.ws.close();

    const token = await runInDurableObject(
      env.TenantAgent.getByName(v.payload.sid),
      (_a: TenantAgent, state) =>
        state.storage.sql
          .exec<{ t: string }>("SELECT verify_token AS t FROM hostnames")
          .one().t
    );
    const hashed = await visitorHash(env.SESSION_SECRET, v.payload.sid);
    const call = lines().find((l) => l.event === "model_call");
    const tool = lines().find((l) => l.event === "tool_call");
    const transition = lines().find((l) => l.event === "transition");
    expect(call).toMatchObject({ outcome: "ok", steps: 2, visitor: hashed });
    expect(typeof call?.first_token_ms).toBe("number");
    expect(tool).toMatchObject({
      tool: "add_hostname",
      outcome: "ok",
      visitor: hashed
    });
    expect(String(tool?.hostname_id)).toMatch(/^hn_/);
    expect(transition).toMatchObject({ to_state: "pending", actor: "model" });
    // One server-made id ties the turn together. The browser's request id is not used.
    expect(tool?.correlation_id).toBe(call?.correlation_id);
    expect(transition?.correlation_id).toBe(call?.correlation_id);
    expect(call?.correlation_id).not.toBe("client-chosen-request-id");
    expectClean([
      "USER-TEXT-MARKER",
      "MODEL-REPLY-MARKER",
      "logs-chat.example.com",
      v.payload.sid,
      v.cookie.split("=")[1],
      token
    ]);
  });

  it("GET /healthz is not logged and needs no session", async () => {
    const res = await SELF.fetch(`${BASE}/healthz`);
    expect(res.status).toBe(200);
    expect(lines()).toEqual([]);
  });
});
