# Repro for cloudflare/ai#663

Draft comment for https://github.com/cloudflare/ai/pull/663 ("don't duplicate streamed text
and tool calls on dual-format chunks"). Not posted. It adds an independent reproduction
through the Agents SDK, with numbers.

---

Independent repro on `workers-ai-provider@4.0.0` with `@cf/meta/llama-3.3-70b-instruct-fp8-fast`
on the Workers AI binding, through `@cloudflare/ai-chat@0.12.1` (`AIChatAgent`),
`agents@0.26.0` and `ai@7.0.128`. This confirms both halves of the PR: tool-call arguments
and streamed text.

## Numbers

Same 20 prompts, each asking about one hostname, with one tool
`get_hostname_status({ hostname: string })`:

| Path | Good tool calls |
|---|---|
| `AIChatAgent` + `streamText` + `createWorkersAI({ binding: env.AI })` | 0/20 (two runs) |
| `env.AI.run`, no streaming, `choices[0].message.tool_calls` | 20/20 |
| `env.AI.run`, streaming, rebuilt from `choices[0].delta.tool_calls` only | 20/20 |
| First row, with the binding wrapped to drop the native copy (rule below) | 20/20 (two runs) |

In every failing run the model picked the right tool, but the persisted UI part was
`state: "output-error"`, `input: {}`, and the error text was masked as "An error occurred."
Nothing was logged. The model retried up to the step limit.

## Wire format

Each SSE chunk carries the payload twice. The tool call:

```
data: {"choices":[{"delta":{"tool_calls":[{"function":{"name":"get_hostname_status"},"id":"chatcmpl-tool-...","index":0,"type":"function"}]}}],"tool_calls":[{"name":"get_hostname_status"}], ...}
data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"{\"hostname\": \""},"index":0}]}}],"tool_calls":[{"arguments":"{\"hostname\": \""}], ...}
data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"shop"},"index":0}]}}],"tool_calls":[{"arguments":"shop"}], ...}
```

Text, with no tools passed:

```
top-level response, joined:     "custom hostnames are ready"
choices[0].delta.content, joined: "custom hostnames are ready"
```

## Where it breaks

`dist/index.mjs`, `getMappedStream`: `emitToolCallDeltas(chunk.tool_calls, ...)` for the native
copy and `emitToolCallDeltas(delta.tool_calls, ...)` for the OpenAI copy both run on the same
chunk. The native copy has no `index`, so `tc.index ?? 0` merges it into call 0, and every
argument fragment is appended twice:

```
{"hostname": "shop.acme.io"}  ->  {"hostname": "{"hostname": "shopshop.ac.acmeme.io"}.io"}
```

The native `response` and `delta.content` blocks do the same to text.

## Minimal repro

Replay a captured stream through a fake binding. No network needed:

```ts
const binding = { run: async () => replay(capturedSse) } as unknown as Ai;
const result = streamText({
  model: createWorkersAI({ binding })("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
  prompt: "Why is shop.acme.io not working yet?",
  tools: { get_hostname_status: tool({ inputSchema: z.object({ hostname: z.string() }), execute: async (i) => i }) },
  stopWhen: stepCountIs(1)
});
// 4.0.0: fullStream has a tool-error part and no tool-result.
// Text capture with no tools: result.text is twice the expected length.
```

## Fix

The PR's rule, which we apply as an interim wrapper around the binding: drop the native
`tool_calls` only when `choices[0].delta.tool_calls` is a non-empty array, and drop the native
`response` only when `choices[0].delta.content` is a non-empty string. Native-only chunks and
the role-priming chunk (`delta.content: ""` next to native text) pass through unchanged. With
that in place, tool calls go to 20/20 and no reply text is doubled across 25 live turns.
We're pinned to exactly 4.0.0 until a release includes this.
