// Before the first token arrives, a model call gets one retry on a 5xx or a timeout.
// After the first token nothing is retried, so a reply is never sent twice.
// The wrapper leaves every other part of the model untouched.

type StreamPart = { type: string };
type StreamResult = { stream: ReadableStream<StreamPart> };
type DoStream = (options: {
  abortSignal?: AbortSignal;
}) => PromiseLike<StreamResult>;

// Parts that carry model output. stream-start and response-metadata do not count.
const CONTENT = new Set([
  "text-start",
  "text-delta",
  "reasoning-start",
  "reasoning-delta",
  "tool-input-start",
  "tool-input-delta",
  "tool-call",
  "error"
]);

export class FirstTokenTimeoutError extends Error {
  constructor() {
    super("no first token in time");
  }
}

function is5xx(error: unknown): boolean {
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === "number" && status >= 500;
}

async function firstContent(
  stream: ReadableStream<StreamPart>,
  timeoutMs: number,
  onTimeout: () => void
): Promise<ReadableStream<StreamPart>> {
  const reader = stream.getReader();
  const buffered: StreamPart[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new FirstTokenTimeoutError());
    }, timeoutMs);
  });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      buffered.push(value);
      if (CONTENT.has(value.type)) break;
    }
  } catch (e) {
    reader.cancel().catch(() => {});
    throw e;
  } finally {
    clearTimeout(timer);
  }
  return new ReadableStream<StreamPart>({
    start(controller) {
      for (const part of buffered) controller.enqueue(part);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    }
  });
}

export function withFirstTokenRetry<M extends object>(
  model: M,
  firstTokenMs: number,
  retries: number
): M {
  const original = (model as unknown as { doStream: DoStream }).doStream.bind(
    model
  );
  const doStream: DoStream = async (options) => {
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const outer = options.abortSignal;
      const forward = () => controller.abort(outer?.reason);
      outer?.addEventListener("abort", forward, { once: true });
      try {
        const result = await original({
          ...options,
          abortSignal: controller.signal
        });
        const stream = await firstContent(result.stream, firstTokenMs, () =>
          controller.abort()
        );
        return { ...result, stream };
      } catch (e) {
        outer?.removeEventListener("abort", forward);
        const retryable = e instanceof FirstTokenTimeoutError || is5xx(e);
        if (attempt < retries && retryable && !outer?.aborted) continue;
        throw e;
      }
    }
  };
  return new Proxy(model, {
    get(target, prop, receiver) {
      return prop === "doStream"
        ? doStream
        : Reflect.get(target, prop, receiver);
    }
  });
}
