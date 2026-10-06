import { createWorkersAI } from "workers-ai-provider";
import { routeAgentRequest } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
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
import { withDedupedStreams } from "./ai/dedupe-stream";
import { LIMITS } from "./config/limits";
import { MODEL_ID } from "./config/model";

const SYSTEM_PROMPT = `You help SaaS teams set up custom hostnames.
You explain DNS findings in plain language. You never claim a hostname is verified unless a tool result says so.`;

// Hostname tools arrive in S5. Until then the model gets no tools at all.
export function buildTools(): ToolSet {
  return {};
}

export class TenantAgent extends AIChatAgent<Env> {
  // Durable chat recovery (stream resume after eviction) is always on in @cloudflare/ai-chat.
  maxPersistedMessages = LIMITS.chat.maxPersistedMessages;

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const workersai = createWorkersAI({
      binding: withDedupedStreams(this.env.AI)
    });

    const result = streamText({
      model: workersai(MODEL_ID, { sessionAffinity: this.sessionAffinity }),
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
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
