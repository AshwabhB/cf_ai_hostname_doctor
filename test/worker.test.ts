import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { LIMITS } from "../src/config/limits";
import { MODEL_ID } from "../src/config/model";
import { TenantAgent, buildTools } from "../src/server";

describe("worker routing", () => {
  it("returns 404 for paths outside the agent routes", async () => {
    const res = await SELF.fetch("https://example.com/nope");
    expect(res.status).toBe(404);
  });

  it("routes /agents/tenant-agent/<name> to a TenantAgent with empty history", async () => {
    const res = await SELF.fetch(
      "https://example.com/agents/tenant-agent/visitor-a/get-messages"
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});

describe("starter demo removal", () => {
  it("gives the model no tools until S5 adds the hostname tools", () => {
    expect(Object.keys(buildTools())).toEqual([]);
  });

  it("does not expose the starter's MCP server callables", () => {
    const proto = TenantAgent.prototype as unknown as Record<string, unknown>;
    expect(proto.addServer).toBeUndefined();
    expect(proto.removeServer).toBeUndefined();
  });
});

describe("config", () => {
  it("allows at least one tool call and one answer per turn", () => {
    expect(Number.isInteger(LIMITS.chat.maxSteps)).toBe(true);
    expect(LIMITS.chat.maxSteps).toBeGreaterThanOrEqual(2);
  });

  it("keeps more persisted messages than one turn can produce", () => {
    expect(LIMITS.chat.maxPersistedMessages).toBeGreaterThan(
      LIMITS.chat.maxSteps * 2
    );
  });

  it("pins the Llama 3.3 70B fp8-fast model", () => {
    expect(MODEL_ID).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  });
});
