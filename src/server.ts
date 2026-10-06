import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import type { Connection, WSMessage } from "agents";
import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText,
  type ToolSet
} from "ai";
import {
  DurableObject,
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep
} from "cloudflare:workers";
import { modelFactory } from "./ai/model";
import { LIMITS } from "./config/limits";
import { SESSION_EXPIRED_CLOSE } from "./config/protocol";
import { SESSION_EXP_PARAM, handleRequest } from "./router";
import {
  FrameRateLimiter,
  checkFrame,
  rebuildChatRequest,
  utf8Length
} from "./security/frames";

const SYSTEM_PROMPT = `You help SaaS teams set up custom hostnames.
You explain DNS findings in plain language. You never claim a hostname is verified unless a tool result says so.`;

// Hostname tools arrive in S5. Until then the model gets no tools at all.
export function buildTools(): ToolSet {
  return {};
}

function sendError(connection: Connection, status: number, title: string) {
  connection.send(JSON.stringify({ type: "hd_error", status, title }));
}

export class TenantAgent extends AIChatAgent<Env> {
  // The instance name is the visitor's sid. The browser never needs it.
  static options = { sendIdentityOnConnect: false };

  // Durable chat recovery (stream resume after eviction) is always on in @cloudflare/ai-chat.
  maxPersistedMessages = LIMITS.chat.maxPersistedMessages;

  private frameLimiter = new FrameRateLimiter();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The SDK wraps onMessage in its constructors. Wrapping again here puts the
    // guard in front of state sync, RPC and the chat protocol.
    const sdkOnMessage = this.onMessage.bind(this);
    this.onMessage = (connection, message) =>
      this.guardFrame(connection, message, sdkOnMessage);
    const sdkOnClose = this.onClose.bind(this);
    this.onClose = (connection, code, reason, wasClean) => {
      this.frameLimiter.forget(connection.id);
      return sdkOnClose(connection, code, reason, wasClean);
    };
  }

  private async guardFrame(
    connection: Connection,
    message: WSMessage,
    next: (connection: Connection, message: WSMessage) => void | Promise<void>
  ) {
    const exp = Number(
      new URL(connection.uri ?? "http://invalid/").searchParams.get(
        SESSION_EXP_PARAM
      )
    );
    if (!Number.isFinite(exp) || exp <= Math.floor(Date.now() / 1000)) {
      connection.close(SESSION_EXPIRED_CLOSE, "session expired");
      return;
    }
    // Cheap checks before spending a rate limit token or parsing.
    if (typeof message !== "string") {
      connection.close(1003, "binary frames not accepted");
      return;
    }
    if (utf8Length(message) > LIMITS.ws.maxFrameBytes) {
      connection.close(1009, "frame too large");
      return;
    }
    if (!this.frameLimiter.take(connection.id, Date.now())) {
      sendError(connection, 429, "too many frames");
      return;
    }

    const verdict = checkFrame(message);
    switch (verdict.kind) {
      case "close":
        connection.close(verdict.code, verdict.reason);
        return;
      case "reject":
        sendError(connection, verdict.status, verdict.title);
        return;
      case "chat":
        if (this.messages.some((m) => m.id === verdict.message.id)) {
          sendError(connection, 400, "invalid chat request");
          return;
        }
        return next(
          connection,
          rebuildChatRequest(verdict.requestId, this.messages, verdict.message)
        );
      case "pass":
        return next(connection, message);
    }
  }

  // State only ever changes on the server.
  validateStateChange(_nextState: unknown, source: Connection | "server") {
    if (source !== "server") throw new Error("client state is read only");
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const result = streamText({
      model: modelFactory.create(this.env.AI, this.sessionAffinity),
      system: SYSTEM_PROMPT,
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message"
      }),
      tools: buildTools(),
      stopWhen: stepCountIs(LIMITS.chat.maxSteps),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }
}

// Ownership per hostname. Implemented in S6.
export class HostnameRegistry extends DurableObject<Env> {}

export type VerifyParams = {
  tenantId: string;
  hostnameId: string;
  hostname: string;
  generation: number;
  run: number;
};

// Background DNS verification. Implemented in S6.
export class VerifyWorkflow extends WorkflowEntrypoint<Env, VerifyParams> {
  async run(
    _event: WorkflowEvent<VerifyParams>,
    _step: WorkflowStep
  ): Promise<never> {
    throw new Error("VerifyWorkflow is not implemented until S6");
  }
}

export default {
  fetch: handleRequest
} satisfies ExportedHandler<Env>;
