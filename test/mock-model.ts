// Scripted models for chat tests. Each call to doStream plays the next step.
import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";

type Part = Record<string, unknown>;
export type Step =
  | { kind: "text"; text: string; delayMs?: number }
  | { kind: "tools"; calls: Array<{ name: string; input: unknown }> }
  | { kind: "error5xx" }
  | { kind: "silent" };

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 }
};

let callSeq = 0;

function partsFor(step: Step): Part[] {
  if (step.kind === "text") {
    return [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: step.text },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage }
    ];
  }
  if (step.kind === "tools") {
    return [
      { type: "stream-start", warnings: [] },
      ...step.calls.map((c) => ({
        type: "tool-call",
        toolCallId: `call_${callSeq++}`,
        toolName: c.name,
        input: typeof c.input === "string" ? c.input : JSON.stringify(c.input)
      })),
      {
        type: "finish",
        finishReason: { unified: "tool-calls", raw: "tool_calls" },
        usage
      }
    ];
  }
  return [];
}

export function scriptedModel(steps: Step[]) {
  let i = 0;
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      const step = steps[Math.min(i++, steps.length - 1)];
      if (step.kind === "error5xx") {
        throw new APICallError({
          message: "upstream 503",
          url: "workers-ai",
          requestBodyValues: {},
          statusCode: 503,
          isRetryable: true
        });
      }
      if (step.kind === "silent") {
        // Opens the stream but never sends a content chunk. Honours abort like the real
        // provider, which passes the signal to env.AI.run.
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              options.abortSignal?.addEventListener("abort", () =>
                controller.error(new DOMException("aborted", "AbortError"))
              );
            }
          })
        };
      }
      const parts = partsFor(step);
      const delay = step.kind === "text" ? (step.delayMs ?? 0) : 0;
      return {
        stream: new ReadableStream({
          async start(controller) {
            for (const p of parts) {
              if (delay && p.type === "text-delta") {
                await new Promise((r) => setTimeout(r, delay));
              }
              controller.enqueue(p as never);
            }
            controller.close();
          }
        })
      };
    }
  });
  return model;
}
