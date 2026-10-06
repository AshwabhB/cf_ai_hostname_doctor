// Every tool, run against a row in every state: nothing the model calls can reach
// verified, active or a delete.
import { env, runInDurableObject } from "cloudflare:test";
import type { ModelMessage, ToolExecutionOptions } from "ai";

type Opts = ToolExecutionOptions<never>;
import { describe, expect, it } from "vitest";
import { LIMITS } from "../src/config/limits";
import {
  buildStateBlock,
  estimateTokens,
  trimHistory,
  type HostnameSummary
} from "../src/ai/context";
import { TOOL_NAMES, buildTools } from "../src/ai/tools";
import { DiagnosisService } from "../src/hostnames/diagnosis";
import { normalizeHostname } from "../src/hostnames/normalize";
import { requiredRecords } from "../src/hostnames/records";
import { migrate } from "../src/hostnames/schema";
import { HostnameService } from "../src/hostnames/service";
import { STATES } from "../src/hostnames/state-machine";

const ZONE = "hostname-doctor.bhatnagarashwabh.workers.dev";

async function withTools<T>(
  fn: (h: {
    tools: ReturnType<typeof buildTools>;
    storage: DurableObjectStorage;
    hostnames: HostnameService;
  }) => Promise<T>
) {
  const stub = env.TenantAgent.getByName(`tools-${crypto.randomUUID()}`);
  return runInDurableObject(stub, async (_a, state) => {
    migrate(state.storage);
    let g = 1;
    const hostnames = new HostnameService(state.storage, {
      register: async () => g++,
      now: () => Date.now(),
      serviceZone: ZONE
    });
    const diagnoses = new DiagnosisService(state.storage, {
      now: () => Date.now(),
      diagnose: async () => ({ verifiable: true, findings: [], lookups: 0 })
    });
    const tools = buildTools({
      hostnames,
      diagnoses,
      fallbackOrigin: ZONE,
      turnId: "turn-1",
      now: () => Date.now()
    });
    return fn({ tools, storage: state.storage, hostnames });
  });
}

const opts = (id: string) =>
  ({ toolCallId: id, messages: [] }) as unknown as Opts;

async function call(
  tools: ReturnType<typeof buildTools>,
  name: string,
  input: unknown,
  id = "c1"
) {
  const t = tools[name] as {
    execute: (i: unknown, o: Opts) => Promise<unknown>;
  };
  return t.execute(input, opts(id));
}

describe("tools cannot reach verified, active or delete", () => {
  it("leaves every state untouched except the retries the table allows the model", async () => {
    await withTools(async ({ tools, storage }) => {
      let n = 0;
      for (const state of STATES) {
        for (const name of TOOL_NAMES) {
          const hostname = `t${n++}.example.com`;
          storage.sql.exec(
            `INSERT INTO hostnames (id, hostname, generation, state, version, verify_token, created_at, updated_at)
             VALUES (?, ?, 1, ?, 1, 'tok', ?, ?)`,
            `hn_${n.toString(16).padStart(24, "0")}`,
            hostname,
            state,
            n,
            n
          );
          await call(
            tools,
            name,
            name === "list_hostnames" ? {} : { hostname },
            `c${n}`
          );
        }
      }
      const moves = storage.sql
        .exec<{ from_state: string | null; to_state: string; actor: string }>(
          "SELECT from_state, to_state, actor FROM events ORDER BY id"
        )
        .toArray();
      for (const m of moves) {
        expect(["verified", "active", "deleting", "deleted"]).not.toContain(
          m.to_state
        );
        expect(m.actor).toBe("model");
      }
      // Only retry_hostname on failed and conflict rows moved anything.
      expect(moves).toEqual([
        { from_state: "failed", to_state: "pending", actor: "model" },
        { from_state: "conflict", to_state: "pending", actor: "model" }
      ]);
    });
  });

  it("propose_delete returns a card and deletes nothing", async () => {
    await withTools(async ({ tools, hostnames }) => {
      const created = await hostnames.create({
        hostname: "card.example.com",
        idempotencyKey: "k",
        requestHash: "h",
        actor: "user"
      });
      if (!created.ok) throw new Error("create failed");
      const result = (await call(tools, "propose_delete", {
        hostname: "card.example.com"
      })) as Record<string, unknown>;
      expect(result).toMatchObject({
        confirmation_requested: true,
        hostname: "card.example.com"
      });
      expect(hostnames.findLive("card.example.com")?.state).toBe("pending");
    });
  });

  it("add_hostname runs as the model, gives exact records, and is idempotent per tool call", async () => {
    await withTools(async ({ tools, storage }) => {
      const first = (await call(
        tools,
        "add_hostname",
        { hostname: "Add.Example.com" },
        "same"
      )) as Record<string, unknown>;
      const again = (await call(
        tools,
        "add_hostname",
        { hostname: "Add.Example.com" },
        "same"
      )) as Record<string, unknown>;
      expect(first).toMatchObject({
        added: true,
        hostname: "add.example.com",
        records: {
          apex: false,
          txt: { type: "TXT", name: "_cf-custom-hostname.add.example.com" },
          routing: { type: "CNAME", name: "add.example.com", value: ZONE }
        }
      });
      expect(again).toMatchObject({ added: true });
      expect(
        storage.sql
          .exec<{ n: number }>("SELECT COUNT(*) AS n FROM hostnames")
          .one().n
      ).toBe(1);
      expect(
        storage.sql
          .exec<{ actor: string }>("SELECT actor FROM events")
          .toArray()
      ).toEqual([{ actor: "model" }]);
    });
  });

  it("add_hostname refuses the service's own zone", async () => {
    await withTools(async ({ tools }) => {
      for (const hostname of [ZONE, `x.${ZONE}`]) {
        const result = (await call(
          tools,
          "add_hostname",
          { hostname },
          hostname
        )) as Record<string, unknown>;
        expect(result).toMatchObject({ added: false });
        expect(String(result.error)).toContain("belongs to the service");
      }
    });
  });

  it("tells the model when a hostname is not found", async () => {
    await withTools(async ({ tools }) => {
      for (const name of [
        "get_hostname",
        "explain_findings",
        "retry_hostname",
        "propose_delete"
      ]) {
        expect(
          await call(tools, name, { hostname: "nope.example.com" })
        ).toMatchObject({ found: false });
      }
    });
  });
});

describe("normalization and the service zone", () => {
  it("refuses FALLBACK_ORIGIN and names under it only when the zone is given", () => {
    for (const host of [
      ZONE,
      `${ZONE}.`,
      `shop.${ZONE}`,
      `A.B.${ZONE.toUpperCase()}`
    ]) {
      expect(normalizeHostname(host, { serviceZone: ZONE })).toEqual({
        ok: false,
        error: "service_hostname"
      });
    }
    // A different name that merely ends with the same characters is not under the zone.
    expect(normalizeHostname(`not${ZONE}`, { serviceZone: ZONE }).ok).toBe(
      true
    );
    expect(
      normalizeHostname(`shop.notbhatnagarashwabh.workers.dev`, {
        serviceZone: ZONE
      }).ok
    ).toBe(true);
    // DNS checks still accept the fallback origin as a CNAME target.
    expect(normalizeHostname(ZONE).ok).toBe(true);
  });
});

describe("context budget", () => {
  const msg = (role: "user" | "assistant", text: string): ModelMessage =>
    role === "user"
      ? { role, content: text }
      : { role, content: [{ type: "text", text }] };

  it("keeps at most the last 12 messages", () => {
    const history = Array.from({ length: 30 }, (_, i) =>
      msg(i % 2 ? "assistant" : "user", `m${i}`)
    );
    const kept = trimHistory(history);
    expect(kept).toHaveLength(LIMITS.chat.historyMessages);
    expect(kept.at(-1)).toEqual(history.at(-1));
  });

  it("drops the oldest messages to fit 6k tokens and always keeps the newest", () => {
    const big = "x".repeat(LIMITS.chat.charsPerToken * 2500);
    const history = [
      msg("user", big),
      msg("assistant", big),
      msg("user", big),
      msg("user", "latest")
    ];
    const kept = trimHistory(history);
    const tokens = kept.reduce(
      (n, m) => n + estimateTokens(JSON.stringify(m)),
      0
    );
    expect(tokens).toBeLessThanOrEqual(LIMITS.chat.historyMaxTokens);
    expect(kept.at(-1)).toEqual(msg("user", "latest"));
    expect(kept.length).toBeLessThan(history.length);
  });

  it("never starts the history on a tool result", () => {
    const tool: ModelMessage = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "1",
          toolName: "get_hostname",
          output: { type: "json", value: {} }
        }
      ]
    };
    const kept = trimHistory([tool, msg("assistant", "a"), msg("user", "b")]);
    expect(kept[0].role).not.toBe("tool");
  });

  it("caps STATE at 1.5k tokens by dropping hostnames and saying how many", () => {
    const summaries: HostnameSummary[] = Array.from({ length: 25 }, (_, i) => ({
      id: `hn_${i.toString(16).padStart(24, "0")}`,
      hostname: `host-${i}-${"a".repeat(40)}.example.com`,
      display_hostname: `host-${i}.example.com`,
      state: "pending",
      records: requiredRecords(
        `host-${i}-${"a".repeat(40)}.example.com`,
        "0".repeat(32),
        ZONE
      ),
      last_checked_at: null,
      finding_codes: ["TXT_MISSING", "CNAME_MISSING"]
    }));
    const block = buildStateBlock(summaries, new Date(0));
    expect(estimateTokens(block)).toBeLessThanOrEqual(
      LIMITS.chat.stateMaxTokens
    );
    expect(block).toMatch(/"omitted_hostnames":[1-9]/);
    expect(block.startsWith("CURRENT_TIME_UTC: 1970-01-01T00:00:00.000Z")).toBe(
      true
    );
  });
});

describe("required records", () => {
  it("never tells an apex domain to add a plain CNAME", () => {
    for (const host of [
      "ashwabh-demo.duckdns.org",
      "example.com",
      "bücher.de"
    ]) {
      const r = requiredRecords(host, "tok", ZONE);
      expect(r.apex, host).toBe(true);
      expect(r.routing.type).toBe("ALIAS or flattened CNAME");
    }
    const sub = requiredRecords("shop.example.com", "tok", ZONE);
    expect(sub).toMatchObject({
      apex: false,
      routing: { type: "CNAME", value: ZONE }
    });
    expect(sub.txt).toEqual({
      type: "TXT",
      name: "_cf-custom-hostname.shop.example.com",
      value: "tok"
    });
  });
});
