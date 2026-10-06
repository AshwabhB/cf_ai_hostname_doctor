import { describe, expect, it } from "vitest";
import { LIMITS } from "../src/config/limits";
import { MODEL_ID } from "../src/config/model";
import { TOOL_NAMES, buildTools } from "../src/ai/tools";
import { TenantAgent } from "../src/server";

describe("starter demo removal", () => {
  it("exposes exactly the six hostname tools and nothing from the starter", () => {
    expect(Object.keys(buildTools())).toEqual([]);
    expect([...TOOL_NAMES].sort()).toEqual([
      "add_hostname",
      "explain_findings",
      "get_hostname",
      "list_hostnames",
      "propose_delete",
      "retry_hostname"
    ]);
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
