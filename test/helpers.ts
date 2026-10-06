import { SELF, env } from "cloudflare:test";
import { MockLanguageModelV4 } from "ai/test";
import { vi } from "vitest";
import { modelFactory } from "../src/ai/model";
import {
  cookieName,
  encodeSession,
  newSession,
  type SessionPayload
} from "../src/security/session";

export const BASE = "https://hostname-doctor.test";
export const ORIGIN = "http://localhost:5173";

export const nowSeconds = () => Math.floor(Date.now() / 1000);

export type Visitor = { payload: SessionPayload; cookie: string };

export async function visitor(
  overrides: Partial<SessionPayload> = {}
): Promise<Visitor> {
  const payload = { ...newSession(nowSeconds()), ...overrides };
  const token = await encodeSession(payload, env.SESSION_SECRET);
  return { payload, cookie: `${cookieName(env)}=${token}` };
}

// Every test watches the one place a Workers AI model is created.
export function spyOnModel() {
  return vi.spyOn(modelFactory, "create");
}

export function mockModelReply(text: string) {
  return new MockLanguageModelV4({
    doStream: {
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "t1" });
          controller.enqueue({ type: "text-delta", id: "t1", delta: text });
          controller.enqueue({ type: "text-end", id: "t1" });
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage: {
              inputTokens: {
                total: 1,
                noCache: 1,
                cacheRead: 0,
                cacheWrite: 0
              },
              outputTokens: { total: 1, text: 1, reasoning: 0 }
            }
          });
          controller.close();
        }
      })
    }
  });
}

type ConnectOptions = {
  origin?: string | null;
  name?: string;
  cookie?: string;
};

export async function upgrade({
  origin = ORIGIN,
  name = "me",
  cookie
}: ConnectOptions) {
  const headers = new Headers({ Upgrade: "websocket" });
  if (origin) headers.set("Origin", origin);
  if (cookie) headers.set("Cookie", cookie);
  return SELF.fetch(`${BASE}/agents/tenant-agent/${name}`, { headers });
}

export type Socket = {
  ws: WebSocket;
  frames: unknown[];
  closed: Promise<{ code: number; reason: string }>;
  next(
    match: (frame: Record<string, unknown>) => boolean,
    timeoutMs?: number
  ): Promise<Record<string, unknown>>;
};

export async function connect(cookie: string): Promise<Socket> {
  const res = await upgrade({ cookie });
  if (res.status !== 101 || !res.webSocket) {
    throw new Error(`upgrade failed with ${res.status}`);
  }
  const ws = res.webSocket;
  const frames: unknown[] = [];
  const waiters: Array<() => void> = [];
  ws.addEventListener("message", (event) => {
    try {
      frames.push(JSON.parse(String(event.data)));
    } catch {
      frames.push(event.data);
    }
    for (const w of waiters.splice(0)) w();
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.addEventListener("close", (event) =>
      resolve({ code: event.code, reason: event.reason })
    )
  );
  ws.accept();

  async function next(
    match: (frame: Record<string, unknown>) => boolean,
    timeoutMs = 3000
  ) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = frames.find(
        (f): f is Record<string, unknown> =>
          typeof f === "object" &&
          f !== null &&
          match(f as Record<string, unknown>)
      );
      if (found) {
        frames.splice(frames.indexOf(found), 1);
        return found;
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("timed out waiting for frame");
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, left);
      });
    }
  }
  return { ws, frames, closed, next };
}

export const isError = (status: number) => (f: Record<string, unknown>) =>
  f.type === "hd_error" && f.status === status;

export function chatFrame(body: unknown, id = "req-1") {
  return JSON.stringify({
    type: "cf_agent_use_chat_request",
    id,
    init: { method: "POST", body: JSON.stringify(body) }
  });
}

export function userMessage(text: string, id = crypto.randomUUID()) {
  return { id, role: "user", parts: [{ type: "text", text }] };
}
