// One chat turn: build the context, run the model with the tools, and handle the
// fallbacks (kill switch, repeated bad tool calls, step cap) without extra model calls.
import {
  InvalidToolInputError,
  NoSuchToolError,
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  pruneMessages,
  stepCountIs,
  streamText,
  type StepResult,
  type ToolSet,
  type UIMessage,
  type UIMessageStreamWriter
} from "ai";
import { LIMITS } from "../config/limits";
import type { DiagnosisService } from "../hostnames/diagnosis";
import type { HostnameService } from "../hostnames/service";
import {
  buildStateBlock,
  readSummaries,
  trimHistory,
  type HostnameSummary
} from "./context";
import { modelFactory } from "./model";
import { SYSTEM_PROMPT } from "./prompts/system.v1";
import { buildTools } from "./tools";
import { FirstTokenTimeoutError, withFirstTokenRetry } from "./first-token";
import { elapsedMs, log } from "../observability/log";

export const KILL_SWITCH_MESSAGE =
  "The assistant is paused right now. Your hostnames keep working, and you can still manage them in the app.";
export const INVALID_TOOL_MESSAGE =
  "I could not run that action, so nothing was changed. Please rephrase what you would like to do.";

export type TurnDeps = {
  env: Env;
  storage: DurableObjectStorage;
  messages: UIMessage[];
  hostnames: HostnameService;
  diagnoses: DiagnosisService;
  requestId: string;
  sessionAffinity?: string;
  abortSignal?: AbortSignal;
  timeouts: { firstChunkMs: number; totalMs: number };
};

function writeText(writer: UIMessageStreamWriter, text: string) {
  const id = crypto.randomUUID();
  writer.write({ type: "text-start", id });
  writer.write({ type: "text-delta", id, delta: text });
  writer.write({ type: "text-end", id });
}

function fixedReply(text: string): Response {
  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      writer.write({ type: "start" });
      writeText(writer, text);
      writer.write({ type: "finish" });
    }
  });
  return createUIMessageStreamResponse({ stream });
}

// Calls the model made with bad arguments or to a tool that does not exist. They show up
// as invalid tool-call parts and as tool-error parts, so ids are counted once.
export function countInvalidToolCalls(
  steps: ReadonlyArray<StepResult<ToolSet>>
): number {
  const ids = new Set<string>();
  for (const step of steps) {
    for (const part of step.content) {
      const invalidCall =
        part.type === "tool-call" &&
        (part as { invalid?: boolean }).invalid === true;
      const invalidError =
        part.type === "tool-error" &&
        (InvalidToolInputError.isInstance(part.error) ||
          NoSuchToolError.isInstance(part.error));
      if (invalidCall || invalidError) ids.add(part.toolCallId);
    }
  }
  return ids.size;
}

// Written from SQL when the step cap ends a turn, so the user still gets an answer.
export function stepCapSummary(summaries: HostnameSummary[]): string {
  const lines = summaries
    .slice(0, LIMITS.chat.stepCapSummaryRows)
    .map(
      (h) =>
        `- ${h.display_hostname}: ${h.state}${h.finding_codes.length ? ` (${h.finding_codes.join(", ")})` : ""}`
    );
  return [
    "I reached the step limit for this reply, so here is where things stand:",
    ...(lines.length ? lines : ["- No hostnames yet."]),
    "Ask again if you want me to keep going."
  ].join("\n");
}

// A plain var, so it can be flipped in the dashboard without a code change.
export function killSwitchOn(env: Env): boolean {
  return String(env.AI_KILL_SWITCH) === "true";
}

// Model output that counts as the first token: text, reasoning or a tool call starting.
const FIRST_TOKEN_CHUNKS = new Set([
  "text-delta",
  "reasoning-delta",
  "tool-input-start",
  "tool-call"
]);

// A short, fixed name for why a model call failed. Error text is never logged.
export function modelErrorClass(error: unknown, aborted: boolean): string {
  if (aborted) return "aborted";
  if (error instanceof FirstTokenTimeoutError) return "first_token_timeout";
  const e = error as { name?: unknown; statusCode?: unknown } | null;
  if (typeof e?.statusCode === "number") return `upstream_${e.statusCode}`;
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return "timeout";
  return "error";
}

export async function runTurn(deps: TurnDeps): Promise<Response> {
  if (killSwitchOn(deps.env)) {
    log("model_call", { outcome: "kill_switch", latency_ms: 0 });
    return fixedReply(KILL_SWITCH_MESSAGE);
  }

  const fallbackOrigin = deps.env.FALLBACK_ORIGIN;
  const system = `${SYSTEM_PROMPT}\n\n${buildStateBlock(
    readSummaries(deps.storage.sql, fallbackOrigin),
    new Date()
  )}`;
  const history = trimHistory(
    pruneMessages({
      messages: await convertToModelMessages(deps.messages),
      toolCalls: "before-last-2-messages",
      reasoning: "before-last-message"
    })
  );
  const tools = buildTools({
    hostnames: deps.hostnames,
    diagnoses: deps.diagnoses,
    fallbackOrigin,
    turnId: deps.requestId,
    now: () => Date.now()
  });

  const base = modelFactory.create(deps.env.AI, deps.sessionAffinity);
  const model =
    typeof base === "string"
      ? base
      : withFirstTokenRetry(
          base,
          deps.timeouts.firstChunkMs,
          LIMITS.chat.retriesBeforeFirstToken
        );
  const tooManyInvalid = (steps: ReadonlyArray<StepResult<ToolSet>>) =>
    countInvalidToolCalls(steps) >= LIMITS.chat.maxInvalidToolCalls;

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      const start = Date.now();
      let firstTokenMs: number | null = null;
      let failure: unknown;
      const result = streamText({
        model,
        system,
        messages: history,
        tools,
        temperature: LIMITS.chat.temperature,
        maxOutputTokens: LIMITS.chat.maxOutputTokens,
        stopWhen: [
          stepCountIs(LIMITS.chat.maxSteps),
          ({ steps }) =>
            tooManyInvalid(steps as ReadonlyArray<StepResult<ToolSet>>)
        ],
        // First-token timeouts and the one retry live in withFirstTokenRetry.
        timeout: { totalMs: deps.timeouts.totalMs },
        maxRetries: 0,
        abortSignal: deps.abortSignal,
        onChunk: ({ chunk }) => {
          if (firstTokenMs === null && FIRST_TOKEN_CHUNKS.has(chunk.type))
            firstTokenMs = elapsedMs(start);
        },
        onError: ({ error }) => {
          failure ??= error;
        }
      });
      writer.merge(result.toUIMessageStream({ sendFinish: false }));

      let steps: ReadonlyArray<StepResult<ToolSet>>;
      try {
        steps = (await result.steps) as ReadonlyArray<StepResult<ToolSet>>;
      } catch (e) {
        log("model_call", {
          outcome: modelErrorClass(
            failure ?? e,
            deps.abortSignal?.aborted === true
          ),
          first_token_ms: firstTokenMs,
          latency_ms: elapsedMs(start)
        });
        throw e;
      }
      const last = steps.at(-1);
      let outcome = failure
        ? modelErrorClass(failure, deps.abortSignal?.aborted === true)
        : "ok";
      if (tooManyInvalid(steps)) {
        outcome = "invalid_tool_calls";
        writeText(writer, INVALID_TOOL_MESSAGE);
      } else if (
        steps.length >= LIMITS.chat.maxSteps &&
        last?.finishReason === "tool-calls"
      ) {
        outcome = "step_cap";
        writeText(
          writer,
          stepCapSummary(readSummaries(deps.storage.sql, fallbackOrigin))
        );
      }
      log("model_call", {
        outcome,
        steps: steps.length,
        first_token_ms: firstTokenMs,
        latency_ms: elapsedMs(start)
      });
      writer.write({ type: "finish" });
    }
  });
  return createUIMessageStreamResponse({ stream });
}
