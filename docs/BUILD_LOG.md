# Build log

## S1. Setup and spikes (2026-10-06)

**Changed.** Scaffolded from cloudflare/agents-starter (commit 4ea6a72) copied into the root,
keeping its Vite, TypeScript, Cloudflare plugin setup and MIT LICENSE. Bumped agents
0.17.4 to 0.26.0 and @cloudflare/ai-chat 0.9.3 to 0.12.1. ai-chat 0.12.1 is built against
ai ^7 and agents 0.26 peers on @ai-sdk/provider ^4, so ai went to 7.0.128 and
workers-ai-provider to 4.0.0 (its v4 peers on ai ^7). Added @ai-sdk/react 4 because
ai-chat 0.12 made it an optional peer. Removed every demo tool (weather, timezone,
calculate, schedule tasks), the MCP server callables and the MCP panel. ChatAgent is now
TenantAgent with no tools. HostnameRegistry and VerifyWorkflow are empty shells for the
bindings, to be filled in S6. Wrangler config, limits.ts, scripts, vitest with the Workers
pool, and .gitignore set up as specified. Node 26.4.0 is inside every engine range.

**Checks run.**
- unit: typecheck, lint (oxlint), 7 tests in test/ pass. Production build passes, and
  dist/ has no spike code (grep for spike class and tool names).
- unit, Spike B: 6/6 pass. Both strategies work in agents 0.26.0. Rewriting the name in the
  URL before routeAgentRequest sends HTTP and WebSocket to the visitor's agent. The
  onBeforeRequest and onBeforeConnect hooks reject a mismatched name with 403 for HTTP and
  for WebSocket upgrades. `AgentRouteMatch` is not exported, so the hook's route arg is typed
  locally.
- fixture, Spike C: 1/1 pass. Workflow called a DO over RPC, slept 2 s (measured 2005 ms),
  called again. Output first=1, second=2, DO count 2, so each step ran once. Total 2023 ms.
- fixture, Spike D: 3/3 pass from inside workerd. TXT cloudflare.com status 0, 29 answers,
  41 ms. CNAME www.github.com status 0, 1 answer, 14 ms. TXT under .invalid status 3
  (NXDOMAIN), 14 ms.
- live model, Spike A: **fails the bar on the full path, passes on the model.**
  - Full path (AIChatAgent, streamText, workers-ai-provider 4.0.0): 0/20, run twice with
    the same result. Median 3192 ms, max 7942 ms.
  - Raw env.AI.run, no streaming: 20/20. Median 967 ms, max 3055 ms.
  - Raw env.AI.run, streaming, rebuilt from `choices[0].delta.tool_calls`: 20/20. Median
    1006 ms, max 1769 ms.

**How Spike A failed.** In all 20 runs the model picked the right tool, but the stored input
was `{}` and the part state was `output-error` with the masked text "An error occurred."
Workers AI streams each tool call twice per chunk: once in `choices[0].delta.tool_calls`
with an `index`, and once in a top-level `tool_calls` with no `index` or `id`. The
provider's stream mapper (workers-ai-provider 4.0.0, dist/index.mjs `getMappedStream`)
calls `emitToolCallDeltas` on both copies. The top-level copy has no index, so it defaults
to 0 and every argument fragment is appended twice to the same call. The result is invalid
JSON like `{"hostname": "{"hostname": "shopshop...`, the AI SDK cannot parse it, and the
tool never runs. This is diagnosed from the raw SSE capture and the provider source. It is
not a model failure. The JSON output fallback is not triggered yet, pending a decision.

**Follow-up: provider workaround.** No newer workers-ai-provider than 4.0.0 (2026-07-22) and
no release with a fix. Open PR cloudflare/ai#663 fixes exactly this for tool calls and text,
not merged. Open PR cloudflare/ai#615 fixes text only. A raw capture showed text is doubled
too: every token is in both `response` and `choices[0].delta.content`.
- Added src/ai/dedupe-stream.ts, a wrapper around the AI binding. It drops the native
  `tool_calls` only when `choices[0].delta.tool_calls` is a non-empty array, and the native
  `response` only when `choices[0].delta.content` is non-empty. That is the #663 rule, so it
  does nothing once the provider is fixed. workers-ai-provider pinned to exactly 4.0.0.
- fixture: 9 new tests replaying live Llama captures (test/fixtures/*.sse) through the real
  provider and AI SDK. With the shim the tool runs with `shop.acme.io` and text streams once,
  also with SSE split one byte at a time. Without it, 4.0.0 gives a tool-error and text of
  exactly twice the length, which pins the upstream bug at this version.
- live model, Spike A full path with the shim, run twice: **20/20 both runs, passes the
  16/20 bar.** 11 runs called the tool once and 9 called it twice before answering, the same
  split in both runs. Median 3855 ms and 3046 ms, max 15361 ms and 6464 ms. Every run ended
  with a text answer. No doubled words in any of the 25 replies in the second run.
- live model, 5 plain questions (CAA, CNAME vs A, propagation, why TXT, TTL): Llama called
  `get_hostname_status` on **5/5** in both runs, then answered. Measured only. S5 handles it.
- docs/upstream-issue.md: a reproduction for #663 with these numbers. Not posted.
- `check` now runs typecheck, lint, test and build. Markdown is out of the formatter. The
  sanity-check workflow pins Node 24. Semgrep workflow unchanged.

**Open issues.**
- Llama 3.3 calls the tool on every plain question, and twice on 9/20 hostname questions.
  To handle in S5.
- `oxfmt --check .` still flags the starter's semgrep.yml. Formatting is not part of `check`.
- `npm audit`: production deps clean. 7 dev-only findings, mostly from the wrangler 4.124
  that @cloudflare/vitest-pool-workers 0.22.0 pins.
- The starter's `check` script runs `oxfmt --check .`, which flags CLAUDE.md, docs/ and the
  starter's own semgrep.yml. Docs were left untouched, as asked.
- Starter UI still offers image attachments. Llama 3.3 is text only. Left for S7.
- Starter README still describes the demo. Left for S10.
