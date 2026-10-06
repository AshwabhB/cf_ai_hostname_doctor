// Workaround for workers-ai-provider 4.0.0 doubling streamed text and tool-call
// arguments. Workers AI puts each token in both a native top-level field and the
// OpenAI-style choices[0].delta, and the provider reads both. This drops the native
// copy only when the delta copy is present, which is the rule in cloudflare/ai#663.
// Once the provider handles this, the delta copy still wins and the shim changes nothing.
// See docs/upstream-issue.md.

type Chunk = {
  response?: unknown;
  tool_calls?: unknown;
  choices?: { delta?: { content?: unknown; tool_calls?: unknown } }[];
};

export function dedupeChunk(chunk: Chunk): Chunk {
  const delta = chunk.choices?.[0]?.delta;
  if (!delta) return chunk;
  const out = { ...chunk };
  if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
    delete out.tool_calls;
  }
  if (typeof delta.content === "string" && delta.content !== "") {
    delete out.response;
  }
  return out;
}

function dedupeLine(line: string): string {
  if (!line.startsWith("data: ")) return line;
  let chunk: unknown;
  try {
    chunk = JSON.parse(line.slice("data: ".length));
  } catch {
    // [DONE] and anything else that is not JSON passes through untouched.
    return line;
  }
  if (typeof chunk !== "object" || chunk === null) return line;
  return `data: ${JSON.stringify(dedupeChunk(chunk as Chunk))}`;
}

export function dedupeSseStream(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  return new TransformStream({
    transform(bytes, controller) {
      pending += decoder.decode(bytes, { stream: true });
      const lines = pending.split("\n");
      // The last piece may be a partial line. Hold it until the next chunk.
      pending = lines.pop() ?? "";
      if (lines.length > 0) {
        controller.enqueue(
          encoder.encode(lines.map(dedupeLine).join("\n") + "\n")
        );
      }
    },
    flush(controller) {
      pending += decoder.decode();
      if (pending !== "")
        controller.enqueue(encoder.encode(dedupeLine(pending)));
    }
  });
}

// Wraps the AI binding so streamed results pass through dedupeSseStream.
// Non-streaming results are returned as they are.
export function withDedupedStreams(ai: Ai): Ai {
  return new Proxy(ai, {
    get(target, prop) {
      if (prop === "run") {
        return async (...args: Parameters<Ai["run"]>) => {
          const out: unknown = await target.run(...args);
          return out instanceof ReadableStream
            ? out.pipeThrough(dedupeSseStream())
            : out;
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}
