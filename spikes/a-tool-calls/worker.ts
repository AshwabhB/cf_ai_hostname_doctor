// Spike A: does Llama 3.3 70B fp8-fast make a clean tool call through AIChatAgent?
// The model output is real. Only the tool's return value is a fixed fixture, because
// the spike measures the call the model makes, not the lookup behind it.
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { getAgentByName } from "agents";
import { convertToModelMessages, stepCountIs, streamText, tool } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";
import { withDedupedStreams } from "../../src/ai/dedupe-stream";
import { MODEL_ID } from "../../src/config/model";

// AIChatAgent requires its Env to extend the generated Env, so the spike widens it.
export type SpikeEnv = Env & {
  SpikeChatAgent: DurableObjectNamespace<SpikeChatAgent>;
};

const SYSTEM = `You help SaaS teams set up custom hostnames.
When the user asks about a specific hostname, call get_hostname_status with that hostname before answering.
Explain the findings in plain language.`;

const tools = {
  get_hostname_status: tool({
    description:
      "Look up the verification state and DNS findings for one custom hostname.",
    inputSchema: z.object({
      hostname: z
        .string()
        .describe("The hostname, for example shop.example.com")
    }),
    execute: async ({ hostname }) => ({
      hostname,
      state: "pending",
      findings: [
        { code: "TXT_MISSING", record: `_cf-custom-hostname.${hostname}` }
      ]
    })
  })
};

export class SpikeChatAgent extends AIChatAgent<SpikeEnv> {
  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const workersai = createWorkersAI({
      binding: withDedupedStreams(this.env.AI)
    });
    const result = streamText({
      model: workersai(MODEL_ID),
      system: SYSTEM,
      messages: await convertToModelMessages(this.messages),
      tools,
      stopWhen: stepCountIs(3),
      abortSignal: options?.abortSignal
    });
    return result.toUIMessageStreamResponse();
  }

  async onRequest(request: Request): Promise<Response> {
    const { prompt } = (await request.json()) as { prompt: string };
    const started = Date.now();
    const result = await this.saveMessages([
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: prompt }]
      }
    ]);
    return Response.json({
      result,
      ms: Date.now() - started,
      messages: this.messages
    });
  }
}

const RAW_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "get_hostname_status",
      description:
        "Look up the verification state and DNS findings for one custom hostname.",
      parameters: {
        type: "object" as const,
        properties: {
          hostname: {
            type: "string",
            description: "The hostname, for example shop.example.com"
          }
        },
        required: ["hostname"]
      }
    }
  }
];

// Same prompt and tool sent straight to env.AI.run, bypassing workers-ai-provider and
// the AI SDK, so a failure can be pinned on the model or on the layers above it.
async function rawTrial(
  env: SpikeEnv,
  prompt: string,
  stream: boolean,
  withTools: boolean
) {
  const started = Date.now();
  const raw = await env.AI.run(MODEL_ID, {
    stream,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: prompt }
    ],
    tools: withTools ? RAW_TOOLS : undefined
  });
  if (raw instanceof ReadableStream) {
    return new Response(raw, {
      headers: { "content-type": "text/event-stream" }
    });
  }
  return Response.json({ raw, ms: Date.now() - started });
}

export default {
  async fetch(request: Request, env: SpikeEnv) {
    const url = new URL(request.url);
    if (url.pathname === "/raw" && request.method === "POST") {
      const { prompt } = (await request.json()) as { prompt: string };
      return rawTrial(
        env,
        prompt,
        url.searchParams.get("stream") === "1",
        url.searchParams.get("tools") !== "0"
      );
    }
    const id = url.searchParams.get("id");
    if (url.pathname !== "/trial" || request.method !== "POST" || !id) {
      return new Response("Not found", { status: 404 });
    }
    const agent = await getAgentByName(env.SpikeChatAgent, id);
    return agent.fetch(request);
  }
};
