// Validation for every WebSocket frame a browser sends to TenantAgent.
// It runs before any Agents SDK handler sees the frame. Anything not listed here is
// rejected: client state sync, chat history overwrites, client tool results, tool
// approvals and RPC to methods outside CALLABLES.
import { z } from "zod";
import { LIMITS } from "../config/limits";

// @callable methods the browser may invoke, with their argument schemas.
// Empty until S5 adds confirmDelete.
export const CALLABLES: Record<string, z.ZodType<unknown[]>> = {};

const id = z.string().min(1).max(64);

const TextPart = z
  .object({ type: z.literal("text"), text: z.string().min(1) })
  .strict();

const UserMessage = z
  .object({
    id,
    role: z.literal("user"),
    parts: z.array(TextPart).min(1).max(8)
  })
  .strict()
  .refine(
    (m) =>
      m.parts.reduce((n, p) => n + p.text.length, 0) <=
      LIMITS.chat.maxUserMessageChars,
    { message: "message too long" }
  );

export type UserMessage = z.infer<typeof UserMessage>;

// The browser sends only the new message. History always comes from the server.
const ChatBody = z
  .object({
    messages: z.array(UserMessage).length(1),
    trigger: z.literal("submit-message")
  })
  .strict();

const ChatRequest = z
  .object({
    type: z.literal("cf_agent_use_chat_request"),
    id,
    init: z
      .object({
        method: z.literal("POST"),
        body: z.string().max(LIMITS.ws.maxFrameBytes)
      })
      .strict()
  })
  .strict();

const Passthrough = z.discriminatedUnion("type", [
  z.object({ type: z.literal("cf_agent_chat_clear") }).strict(),
  z.object({ type: z.literal("cf_agent_chat_request_cancel"), id }).strict(),
  z
    .object({
      type: z.literal("cf_agent_stream_resume_request"),
      probeId: id.optional()
    })
    .strict(),
  z.object({ type: z.literal("cf_agent_stream_resume_ack"), id }).strict()
]);

const RpcFrame = z
  .object({
    type: z.literal("rpc"),
    id,
    method: z.string().max(64),
    args: z.array(z.unknown())
  })
  .strict();

export type FrameVerdict =
  | { kind: "pass" }
  | { kind: "chat"; requestId: string; message: UserMessage }
  | { kind: "reject"; status: 400 | 403 | 429; title: string }
  | { kind: "close"; code: number; reason: string };

const reject = (status: 400 | 403 | 429, title: string): FrameVerdict => ({
  kind: "reject",
  status,
  title
});

export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

// Pure check of one frame. Expiry and rate limiting are applied by the caller first.
export function checkFrame(
  message: string | ArrayBuffer | ArrayBufferView
): FrameVerdict {
  if (typeof message !== "string") {
    return { kind: "close", code: 1003, reason: "binary frames not accepted" };
  }
  if (utf8Length(message) > LIMITS.ws.maxFrameBytes) {
    return { kind: "close", code: 1009, reason: "frame too large" };
  }

  let data: unknown;
  try {
    data = JSON.parse(message);
  } catch {
    return reject(400, "frame is not JSON");
  }
  const type =
    typeof data === "object" && data !== null && "type" in data
      ? (data as { type: unknown }).type
      : undefined;

  if (type === "cf_agent_use_chat_request") {
    const frame = ChatRequest.safeParse(data);
    if (!frame.success) return reject(400, "invalid chat request");
    let body: unknown;
    try {
      body = JSON.parse(frame.data.init.body);
    } catch {
      return reject(400, "invalid chat request");
    }
    const parsed = ChatBody.safeParse(body);
    if (!parsed.success) return reject(400, "invalid chat request");
    return {
      kind: "chat",
      requestId: frame.data.id,
      message: parsed.data.messages[0]
    };
  }

  if (type === "rpc") {
    const frame = RpcFrame.safeParse(data);
    if (!frame.success) return reject(400, "invalid rpc frame");
    const schema = Object.hasOwn(CALLABLES, frame.data.method)
      ? CALLABLES[frame.data.method]
      : undefined;
    if (!schema) return reject(403, "method not allowed");
    return schema.safeParse(frame.data.args).success
      ? { kind: "pass" }
      : reject(400, "invalid rpc arguments");
  }

  if (type === "cf_agent_state")
    return reject(403, "client state is read only");

  return Passthrough.safeParse(data).success
    ? { kind: "pass" }
    : reject(400, "unsupported frame");
}

// Rebuilds the chat request so the SDK sees server history plus the one new message.
export function rebuildChatRequest(
  requestId: string,
  history: readonly unknown[],
  message: UserMessage
): string {
  return JSON.stringify({
    type: "cf_agent_use_chat_request",
    id: requestId,
    init: {
      method: "POST",
      body: JSON.stringify({
        messages: [...history, message],
        trigger: "submit-message"
      })
    }
  });
}

type Bucket = { tokens: number; at: number };

// Token bucket per connection. Lives in memory, so it resets if the DO is evicted,
// which only ever makes it more lenient for one burst.
export class FrameRateLimiter {
  private buckets = new Map<string, Bucket>();

  take(connectionId: string, nowMs: number): boolean {
    const { frameBurst, frameRefillPerSecond } = LIMITS.ws;
    const prev = this.buckets.get(connectionId) ?? {
      tokens: frameBurst,
      at: nowMs
    };
    const refilled = Math.min(
      frameBurst,
      prev.tokens + ((nowMs - prev.at) / 1000) * frameRefillPerSecond
    );
    if (refilled < 1) {
      this.buckets.set(connectionId, { tokens: refilled, at: nowMs });
      return false;
    }
    this.buckets.set(connectionId, { tokens: refilled - 1, at: nowMs });
    return true;
  }

  forget(connectionId: string): void {
    this.buckets.delete(connectionId);
  }
}
