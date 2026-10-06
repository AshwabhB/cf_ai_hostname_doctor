// Fixture tests: real Llama 3.3 streams captured from env.AI.run, replayed through
// the real workers-ai-provider 4.0.0 and AI SDK, with and without the shim.
import { stepCountIs, streamText, tool } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { dedupeChunk, withDedupedStreams } from "../src/ai/dedupe-stream";
import { MODEL_ID } from "../src/config/model";
import textSse from "./fixtures/llama-text.sse?raw";
import toolCallSse from "./fixtures/llama-tool-call.sse?raw";

// Replays a capture in small byte chunks so SSE lines get split mid-way.
function replay(sse: string, chunkSize: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(sse);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    }
  });
}

function fakeBinding(sse: string, chunkSize = 7): Ai {
  return { run: async () => replay(sse, chunkSize) } as unknown as Ai;
}

const tools = {
  get_hostname_status: tool({
    description: "Look up one custom hostname.",
    inputSchema: z.object({ hostname: z.string() }),
    execute: async ({ hostname }) => ({ hostname })
  })
};

async function toolCallParts(binding: Ai) {
  const result = streamText({
    model: createWorkersAI({ binding })(MODEL_ID),
    prompt: "Why is shop.acme.io not working yet?",
    tools,
    stopWhen: stepCountIs(1)
  });
  const parts: { type: string; output?: unknown }[] = [];
  for await (const part of result.fullStream) parts.push(part);
  return parts;
}

async function streamedText(binding: Ai) {
  const result = streamText({
    model: createWorkersAI({ binding })(MODEL_ID),
    prompt: "Reply with exactly: custom hostnames are ready"
  });
  return result.text;
}

describe("tool-call fixture", () => {
  it("with the shim, the tool runs with the hostname the model sent", async () => {
    const parts = await toolCallParts(
      withDedupedStreams(fakeBinding(toolCallSse))
    );
    expect(parts.filter((p) => p.type === "tool-error")).toEqual([]);
    const results = parts.filter((p) => p.type === "tool-result");
    expect(results.map((p) => p.output)).toEqual([
      { hostname: "shop.acme.io" }
    ]);
  });

  it("without the shim, provider 4.0.0 corrupts the arguments (upstream bug)", async () => {
    const parts = await toolCallParts(fakeBinding(toolCallSse));
    expect(parts.some((p) => p.type === "tool-result")).toBe(false);
    expect(parts.some((p) => p.type === "tool-error")).toBe(true);
  });

  it("survives SSE lines split one byte at a time", async () => {
    const parts = await toolCallParts(
      withDedupedStreams(fakeBinding(toolCallSse, 1))
    );
    const results = parts.filter((p) => p.type === "tool-result");
    expect(results.map((p) => p.output)).toEqual([
      { hostname: "shop.acme.io" }
    ]);
  });
});

describe("text fixture", () => {
  const expected = "custom hostnames are ready";

  it("with the shim, text streams once", async () => {
    expect(await streamedText(withDedupedStreams(fakeBinding(textSse)))).toBe(
      expected
    );
  });

  it("without the shim, provider 4.0.0 doubles every token (upstream bug)", async () => {
    const text = await streamedText(fakeBinding(textSse));
    expect(text).not.toBe(expected);
    expect(text.length).toBe(expected.length * 2);
  });
});

describe("dedupeChunk rule", () => {
  it("keeps a native-only tool call", () => {
    const chunk = { tool_calls: [{ name: "x" }] };
    expect(dedupeChunk(chunk)).toEqual(chunk);
  });

  it("keeps native text when delta.content is empty", () => {
    const chunk = { response: "Hi", choices: [{ delta: { content: "" } }] };
    expect(dedupeChunk(chunk)).toEqual(chunk);
  });

  it("keeps native tool calls when delta.tool_calls is empty", () => {
    const chunk = {
      tool_calls: [{ name: "x" }],
      choices: [{ delta: { tool_calls: [] } }]
    };
    expect(dedupeChunk(chunk)).toEqual(chunk);
  });

  it("drops both native copies when both delta copies are present", () => {
    const chunk = {
      response: "Hi",
      tool_calls: [{ arguments: "{" }],
      choices: [{ delta: { content: "Hi", tool_calls: [{ index: 0 }] } }]
    };
    expect(dedupeChunk(chunk)).toEqual({ choices: chunk.choices });
  });
});
