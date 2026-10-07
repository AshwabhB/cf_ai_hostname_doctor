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

## S2. Visitor isolation (2026-10-06)

**Changed.**
- Signed `__Host-hd_sid` session cookie (`hd_sid` in dev mode) with HMAC-SHA256 through Web
  Crypto, constant-time comparison, a strict payload schema, 30-day life, renewed inside the
  last 7 days. `GET /api/v1/session` is the only route that sets it.
- The router rewrites `/agents/tenant-agent/me` to the cookie's sid, rejects any other name
  or agent class (the registry included) with 403, and allows only the upgrade and
  `get-messages` on the agent.
- Exact-origin checks on upgrades and every request that is not a GET. No CORS. A body cap,
  RFC 9457 problems and `no-store` on visitor-specific responses.
- A frame guard runs in front of the SDK in TenantAgent, with `sendIdentityOnConnect: false`
  and a `validateStateChange` that refuses client sources. Expired sockets close with 4401.
- Rate limits: `SESSION_LIMITER` (per IP) and `CONNECT_LIMITER` (per sid) bindings, plus a
  per-connection frame bucket in the DO.
- Client fetches the session before connecting, uses the `me` alias, renews on 4401, sends
  only the new message (`prepareSendMessagesRequest`), and sets `syncMessagesToServer: false`.
  Image attachments removed from the UI (button, picker, drag-drop and paste).
- `SESSION_SECRET` generated into `.dev.vars` without printing. A scan found the value in no
  tracked or untracked file, and the generated env.d.ts types it as `string` only.
- docs/SECURITY.md has the route matrix and frame table. `.claude/` added to .gitignore.

**Found while reading the SDK.** Before this stage the browser controlled chat history.
Every chat request carried the full client message list and AIChatAgent saved it with
`_deleteStaleRows: true`. `cf_agent_chat_messages` could overwrite history too, and
`routeAgentRequest` would have routed `/agents/hostname-registry/*` from the browser.

**Checks run.**
- unit: typecheck, lint, 75 tests pass (session 14, router 26, frames 21, dedupe 9,
  worker 5). They cover a tampered cookie, an expired cookie, another visitor's agent, the
  registry path, wrong and missing origin upgrades, client setState, unlisted RPC, history
  overwrite, client tool results, an oversized frame, a binary frame, unknown fields, file
  parts, an over-long message, frame floods and both 429s. Every rejection test asserts
  `modelFactory.create` was never called. The valid-turn test proves the spy sees calls
  made inside the DO (called exactly once, with a mock model).
- unit, mutation check: with the frame guard bypassed, all 20 WebSocket frame tests fail.
  The guard was restored and the suite rerun.
- fixture: spikes B, C, D still 10/10.
- live model, browser (in-app Chromium, local dev): session 204, then `get-messages` 200
  with the cookie, then a live turn answered once. Under `vite preview` on the same port,
  stopping and restarting the server left the page loaded (one navigation, loaded before
  the restart). The socket went Disconnected, then Connected again, history was intact,
  and a second live turn worked on the reconnected socket.
- Not run in the browser: the 4401 expiry reconnect. The server close is covered by a unit
  test and the client renewal is a small `onClose` handler, but the cookie is HttpOnly, so
  forcing a near-expiry cookie into the in-app browser was not practical.

**Open issues.**
- The production origin is allowed alongside `http://localhost:5173` in one var, as asked.
- `SESSION_SECRET` must be set with `wrangler secret put` before S11.
- The pre-commit scan found the dev secret in `dist/hostname_doctor/.dev.vars`. The Cloudflare
  Vite plugin copies `.dev.vars` into the build for `vite preview`. dist/ is gitignored and
  deploy does not upload it, but dist/ must never be shared. Noted in SECURITY.md.
- Under `vite preview` the Worker read `.dev.vars` (dev mode cookie). Production uses the
  `__Host-` name.

## S3. Data model and REST API (2026-10-06)

**Changed.**
- Production `ALLOWED_ORIGINS` is now only the workers.dev origin. Localhost moved to
  `.dev.vars`. A test pins the production value, and tests set their own origin so CI does
  not depend on `.dev.vars`.
- Forward-only migrations in `TenantAgent.onStart` (src/hostnames/schema.ts) create the four
  section 4 tables and indexes, tracked in `hd_schema_migrations`. Bound parameters only.
- `HostnameService` (src/hostnames/service.ts) is the one service behind REST and the
  callables. `transition()` checks the section 2 table, actor, generation and version inside
  `transactionSync` and writes the row and event together. `changes()` is used for the
  compare-and-set, because `rowsWritten` also counts index writes. Create awaits
  `HostnameRegistry.register()`, then re-checks the key, duplicate and quota at commit.
- `normalizeHostname` (src/hostnames/normalize.ts) uses `node:url` `domainToASCII` and
  `domainToUnicode` (UTS #46, available in workerd) and tldts 7.4.16 for public suffixes,
  ICANN and private. Rows store punycode, and views add `display_hostname`.
- REST v1 per DESIGN section 5, plus `API_LIMITER` (60/min per sid), RFC 9457 types,
  ETag, If-None-Match 304, If-Match 428/412, Idempotency-Key 428/422 with replay.
- Limits: 25 live hostnames per visitor, idempotency keys 24 h and 500 rows, page size 20
  default and 50 max. DESIGN.md does not name a page size, so these are only in limits.ts.
- Callables `confirmDelete(id, etag)` and `retryHostname(id)` are in the frame allowlist with
  argument schemas. The second is not called `retry` because `Agent` already has a
  `retry()` helper, and overriding it would break SDK internals.
- Delete goes deleting (user) then deleted (system) at once, because nothing can be claimed
  before S6. Retry only moves failed or conflict back to pending. The workflow starts in S6.

**Found while testing.**
- `domainToASCII("shop.example.com/path")` returns `shop.example.com`, silently dropping the
  path. It also accepts the bogus Punycode label `xn--zz`. The normalizer now refuses any
  stray ASCII before IDNA and requires `xn--` labels to round trip.
- The S2 tampered-signature test could pass by luck. The last base64url character of a
  32-byte HMAC carries 2 padding bits, so some flips decode to identical bytes. Tokens now
  must use the canonical encoding, and a test covers the non-canonical spelling.

**Checks run.**
- unit: typecheck, lint, 327 tests pass, three runs in a row. That includes 147 table checks
  of every from, to and actor combination against a hand copy of section 2 (16 allowed),
  the same 147 against real SQLite (row and event written together, or neither), stale
  version and generation, two writers on one version, and 59 normalization tests (55 cases
  covering IDN, trailing dot, 64-character label, IPs, wildcards, reserved names and public
  suffixes). Also idempotency replay, key reuse 422, the 24 h expiry, the 500-row cap,
  paging that stays stable while rows are added and deleted between pages, the quota under
  racing creates, the 404 for another visitor's id, and the callables over the WebSocket.
- unit, mutation check: removing the commit-time re-checks in create makes exactly the two
  race tests fail. Restored.
- deployed: not run. Local dev smoke test with curl against `npm run dev`: session 204,
  create 201 with `display_hostname: shop.bücher.de`, same-key replay 201 with
  `idempotent-replayed`, list 200, foreign origin 403, delete with If-Match 202, events
  `pending:user, deleting:user, deleted:system`. The chat page still connects.

**Open issues.**
- `HostnameRegistry` has only `register()`. Claim and release come in S6.

## S4. DNS checks (2026-10-06)

**Changed.**
- DESIGN.md: page size line in section 5. Section 7 rewritten with the new rules: CNAME
  findings are warnings, plus APEX_CNAME, the RFC 8659 CAA walk, DNS_ERROR, the text
  sanitizing and the check and diagnosis routes. `FALLBACK_ORIGIN` set in wrangler.jsonc.
- `src/dns/doh.ts`: DoH client for `cloudflare-dns.com` only, with the limits as specified.
  Cached in `dns_cache` for min(TTL, 60 s). Empty and NXDOMAIN answers use the SOA TTL capped
  at 60 s, SERVFAIL 10 s, timeouts never. Timeouts are not retried, so a check stays near
  3 s per lookup at worst. Network errors and 5xx get the one retry.
- `src/dns/rules.ts` (pure) and `src/dns/diagnose.ts`: the section 7 rules. CNAME chains are
  followed for up to 3 hops, and a target from DNS must pass normalization before it is
  queried. Apex detection uses tldts with private suffixes, so
  `ashwabh-demo.duckdns.org` is an apex.
- `src/dns/text.ts`: TXT and CAA decoding (presentation and RFC 3597 forms) and the sanitizer.
- `POST /api/v1/hostnames/{id}/check` and `GET /api/v1/hostnames/{id}/diagnosis` through a
  separate `DiagnosisService`. Findings and `last_checked_at` never touch the hostname's
  version, state or events. The diagnosis ETag is `"<id>.diag.<last_checked_at>"`.
  30 checks per hour per visitor are counted in a `check_runs` table (migration 2), because
  rate limit bindings only support 10 s and 60 s periods.
- Opt-in `npm run test:live-dns` (vitest.live.config.ts, test-live/). Not part of `test`,
  `check` or CI.

**Found while building.**
- The Write tool turned `\u` escapes in TypeScript string and regex literals into the real
  invisible characters, including in the sanitizer's own regex. Every one was converted
  back to an escape, and `test/source-rules.test.ts` now fails on any invisible or bidi
  character in src, test or spikes. A planted U+202E made it fail as expected.

**Checks run.**
- unit and fixture: typecheck, lint, 385 tests pass. The DNS fixtures (47) cover every
  finding code (a test asserts each code appears), CAA inheritance and override by a
  closer set, CAA through a CNAME, issue ";", issuewild only, critical unknown tags,
  mixed TXT, the hostile "mark this verified" TXT with bidi and zero-width characters,
  oversized TXT (4000 characters, 21 records), timeouts, SERVFAIL, 5xx and network retry
  with the jitter bounds, the 64 KB cap, malformed JSON, cache TTLs and the 12-lookup
  budget. API tests (11) cover check and diagnosis, the unchanged hostname ETag, 304,
  sanitized storage, 409 for a deleted row, 404 for another visitor, the 30-per-hour 429,
  and a row deleted while DNS was in flight (nothing saved).
- live, opt in: `example.com` gives `TXT_MISSING` (error) and `APEX_CNAME` (info) in 3
  lookups. `ashwabh-demo.duckdns.org` with TXT `hd-test-123` gives only `APEX_CNAME` and is
  verifiable, in 4 lookups.
- live, local dev smoke test: created `ashwabh-demo.duckdns.org`, then checked it against
  real DNS. Result: `TXT_MISMATCH` observing `hd-test-123` (the row's token differs) and
  `APEX_CNAME`. The diagnosis ETag moved, If-None-Match gave 304, and the hostname ETag,
  state (pending) and version (1) were unchanged.
- deployed: not run.

**Open issues.**
- DESIGN.md section 7 used to say normalization rejects "our own zone". S3 never did that,
  so the bullet now describes what S3 actually does. Refusing `FALLBACK_ORIGIN` itself as a
  custom hostname is not implemented.
- To verify the DuckDNS demo, set its TXT to the row's `txt_value`. DuckDNS serves the same
  TXT for `_cf-custom-hostname.<domain>`.

## S5. Chat agent (2026-10-06)

**Changed.**
- Normalization refuses `FALLBACK_ORIGIN` and names under it (`service_hostname`) when
  called with the service zone, for both REST create and the tool. DNS follow-ups still
  accept the fallback as a CNAME target.
- `src/ai/turn.ts`: `streamText` through the shimmed provider, temperature 0.2,
  1024 max output, `stepCountIs(5)`, `pruneMessages`, then history trimmed to the last 12
  messages and 6k tokens. The STATE block is never trimmed.
- `src/ai/tools.ts`: the six section 8 tools. Read-only results are memoized per turn.
  `add_hostname` uses an idempotency key derived from the turn and tool call ids.
  `explain_findings` runs a fresh check when the saved one is over 5 minutes old.
- `src/ai/prompts/system.v1.ts`: versioned prompt with two no-tool examples. About 544
  tokens at 3 characters per token, or about 408 at 4.
- `src/ai/context.ts`: STATE from SQL with UTC time, capped at 1.5k tokens (drops hostnames
  and reports `omitted_hostnames`).
- Context window checked first: 24,000 tokens per the Workers AI model page. Budget is about
  600 + 1,500 + 6,000 + 1,024 plus tool schemas and results.
- Fallbacks: the second invalid tool call ends the turn with a fixed message and zero
  writes. The step cap ends with a summary from SQL and no extra model call. The kill switch
  answers with a fixed message.
- `src/ai/lease.ts` plus migration 3: one turn per visitor, released on every ending, with
  60 s expiry as the backstop.
- `src/ai/first-token.ts`: 10 s first-token limit with one retry on a 5xx or timeout,
  wrapped around the model. The SDK's `maxRetries` is 0, so there is exactly one retry.
  `timeout.totalMs` is 30 s.
- `src/hostnames/records.ts`: one source for the records a customer must add. Apex domains
  get "ALIAS or flattened CNAME", never a plain CNAME.

**Found while building.**
- `stopWhen` runs before `onStepFinish`, and ai 7 reports bad tool calls as `tool-call`
  parts with `invalid: true`. Counting from `steps` inside the stop condition fixed it.
- The SDK's `timeout.firstChunkMs` aborts but does not retry, so the one retry before the
  first token lives in a small wrapper.
- The first live smoke turn told the user to add a plain CNAME for
  `ashwabh-demo.duckdns.org`, an apex. Fixed with `requiredRecords`, and re-run.

**Checks run.**
- unit and mock model: typecheck, lint, 413 tests pass. Chat tests (16) cover:
  - chat injection: no state change, and only the user's create event
  - a TXT carrying instructions: it reaches the model only as sanitized tool data, never in
    the system message
  - two bad tool calls: two model calls, the fixed message, zero rows
  - the step cap: exactly 5 model calls and a SQL summary
  - per-turn memoization: one `findLive`
  - lease contention (409), and the lease freed after an error and after a timeout
  - the 60 s backstop and holder-only release
  - a 5xx retry, a first-token timeout retry, and no second retry
  - the kill switch: no model created
  - the prompt size and budgets

  Tool tests run every tool against every state. The only moves are failed to pending and
  conflict to pending, both by `model`.
- unit, mutation checks: disabling the invalid-call stop makes the bad-args test fail.
  Disabling the lease makes the contention test fail. Both restored.
- live model, Spike A production mode (real TenantAgent, production prompt and tools,
  `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, 2026-10-06):
  - hostname questions: good tool calls 20/20, median 4675 ms, max 18219 ms
  - plain questions with a tool call: **0/5** (S1 was 5/5)
  - hostname turns with more than one tool call: **1/20** (S1 was 9/20); the one repeat was
    `explain_findings` called twice with the same input, so the memo served it
  - target of 1 in 5 or less met on both
  - no answer claimed a hostname was verified
  - the `shop.acme.io` answer reported SERVFAIL, which is real: the resolver returns Status 2,
    "No Reachable Authority at delegation acme.io"
- live model, smoke test in the browser (local dev, the same model id, 2026-10-06): "Please
  add ashwabh-demo.duckdns.org and tell me exactly which DNS records I need" called
  `add_hostname`, then `get_hostname`, and answered with the real TXT name and token. After
  the apex fix, "Which DNS records do I need for ashwabh-demo.duckdns.org?" made one
  `get_hostname` call and answered with the TXT record plus "ALIAS or flattened CNAME" and
  the apex note.
- deployed: not run.

**Open issues.**
- The UI still renders tool parts as raw JSON, and `propose_delete` has no Confirm button yet
  (S7).
- On the add turn the model called `get_hostname` after `add_hostname`, which is redundant
  but harmless.

## S6. Workflow and registry (2026-10-06)

**Changed.**
- `VerifyWorkflow` (src/workflow/verify.ts) extends the SDK's `AgentWorkflow`, so it gets a
  typed RPC stub to the visitor's TenantAgent. Steps: `load`, then per attempt `dns-i`,
  `record-i` and `sleep-i`, then `claim`, `settle` and `activate`, or `give-up`. The token,
  timestamps and DNS answers are all produced inside steps. `runWorkflow` gets an explicit
  `agentBinding`, so routing does not depend on class names surviving the build.
- Backoff of 30 s, 1 m, 2 m and 5 m, then 10 m, giving up after 24 h of sleeps, counted as
  attempts (149 attempts, 148 sleeps). Worst case is 450 steps against the Workflows limit
  of 1,024 per instance on Free (10,000 default on Paid). A test keeps it under half of
  1,024.
- `HostnameRegistry` (src/hostnames/registry.ts): `register`, `claim`, `release`, `owner`.
  First verified claim wins. A same-tenant claim at an older generation is replaced.
- `HostnameLifecycle` (src/hostnames/lifecycle.ts): starts runs on create and retry, handles
  the workflow callbacks (idempotent when repeated, fenced by generation), deletes
  (terminate, release, deleted), and reconciles every row of the section 6 table. Server
  `setState` pushes the hostname summary after every change. The reconcile schedule
  exists only while a visitor has rows that need it.
- Instance ids are `<sid>-<hostnameId>-g<generation>-r<run>`. Workflows ids allow only
  letters, digits, `-` and `_` (up to 100 characters), so DESIGN.md section 6 was corrected
  from the dotted form.
- Migrations 4 and 5: `workflow_run`, `certificate_json`, `registry_released` and
  `workflow_started_at`.
- `test/setup.ts` blocks outbound fetch in unit tests, now that every create starts a real
  workflow.

**Found while building.**
- `Agent` already has a `lifecycle` property, so the getter is `hostnameLifecycle`.
- RPC results are disposable stubs, so steps copy plain fields out before returning.
- Two gaps in my own first version, fixed before testing:
  - a repeated `settle` would have stopped the run before `activate`
  - a claim granted just before a delete would have leaked
- The local engine ignores falsy mocked step results (`mockStepResult(..., null)` does
  nothing), and a mocked error never runs the step body. So "a step running twice" is
  tested by making the first real call of `claim`, `settle` and `activate` commit and then
  throw. The test asserts each ran exactly twice and the events show one verified and one
  active.

**Incident during the live run, and the fix.** The live run on
`shop.ashwabh-demo.duckdns.org` recorded attempts at 20:47, 20:47:35, 20:48:35, 20:50:35
and 20:55:36, all `TXT_MISMATCH` on the old `hd-test-123`. During the following 10-minute
sleep the local Workers runtime crashed at 21:01:22 and Vite restarted it. The engine's
stored queue still held the wake-up for 21:05:36, but its alarm table was empty, so the
instance never woke. It kept reporting itself as in progress. Reconcile did run at 21:07
and 21:17 (the schedule row was fine), but it trusted that status and skipped the row.
Fix: reconcile now uses our own heartbeat. A pending row whose last recorded attempt and
run start are both more than 15 minutes old has a stalled instance, whatever the engine
says. Reconcile terminates it and starts the next run. Migration 5 adds
`workflow_started_at`, so a fresh retry is never mistaken for a stall. Regression test:
age a sleeping run's heartbeat, then reconcile. It must report the row as stalled and
restarted, and run 1 must be terminated. With the stall check disabled the test fails
(`stalled` is empty). A second test leaves a healthy sleeping run alone.

**Checks run.**
- unit and fixture: typecheck, lint, 431 tests pass. Workflow tests (18) cover:
  - the happy path to `active` with a simulated certificate, the claim and the state push
  - the network guard covering workflows
  - steps that commit and then lose their result
  - delete during polling (instance terminated, row deleted, nothing to release)
  - delete of an active hostname (claim released, another visitor then verifies it)
  - late steps after delete and re-add
  - two visitors racing for one claim
  - adopting an instance whose id was not recorded
  - restarting a gone or stalled instance
  - a leftover claim
  - registry drift to `conflict`
  - a stuck delete
  - give-up after all 149 attempts, then retry to `active`
- unit, mutation checks: removing the generation fence makes the late-step test fail.
  Removing first-claim-wins makes the race test fail. Removing settle idempotency makes the
  double-run test fail. Disabling the stall check makes the regression test fail. All
  restored.
- live, local dev (real DNS, local Workflows engine), 2026-10-06: after the TXT was set
  and the fix loaded, the worker reload woke the visitor's DO, `onStart` reconcile found
  run 1 stalled, terminated it, and started run 2. Run 2 did `load`, `dns-0` (verifiable,
  only `CNAME_MISSING` as a warning), `record-0`, `claim` (granted), `settle` and `activate`
  between 21:23:06 and 21:23:07Z. The row reached `active` with a simulated certificate
  (`not_after` 2027-01-04). Events: pending (user) at 20:47:03, verified (system) and
  active (system) at 21:23:07.
- deployed: not run.

**Open issues.**
- Test runs print "hung" and "User called terminate" lines from workflows still sleeping
  when a test ends. They are noise from the local engine, not failures.
- The DuckDNS TXT is now `8b130507b9b7ded3fd7df1fa2f75f393`, so the opt-in live DNS test
  needs `LIVE_DUCKDNS_TXT` set to that value.
- The S5 smoke-test row for `ashwabh-demo.duckdns.org` (a different local visitor) was also
  stalled by the crash. Its reconcile restarts it on its next wake, but its token no longer
  matches the DuckDNS TXT, so it will keep polling and then fail. Local data only.
- A stalled instance that somehow resumed would still pass the generation fence, because
  runs share a generation. Every callback is idempotent, so the outcome is the same.

## S7. UI (2026-10-06)

**Changed.**
- Two-pane UI (`src/app.tsx`, `src/ui/`): the hostname table with live state badges next to
  the chat, fed by server `setState`. Below `md` the panes become Chat and Hostnames tabs.
- Drawer per hostname (native `<dialog>`): state, certificate marked "Simulated", findings
  from `/diagnosis`, records to add with copy buttons, and the event timeline. It refetches
  when the row's state or check time changes.
- Tool results render as small cards. The `propose_delete` card has a button that opens a
  confirm dialog naming the hostname, which calls `confirmDelete`. The model cannot open
  the dialog.
- Empty state is the one line plus three starter prompts. Header shows the connection
  status. Enter sends, Shift+Enter adds a line, and only the send button waits on a reply.
- Markdown through Streamdown with HTML skipped, images and frames disallowed, https-only
  links (`noopener noreferrer`), and incomplete-markdown repair off. DNS strings are plain
  text.
- Production headers from one source (`src/config/security-headers.ts`): written into the
  assets' `_headers` by a build-only Vite plugin and added to the Worker's own responses
  (not the 101 upgrade). The theme script moved to `public/theme.js` to keep
  `script-src 'self'`.
- Starter branding removed (title, description, package name). `@streamdown/code` dropped.
- Server: `HostnameSummary` carries `id`. State is republished on start, after each
  recorded DNS check, and after an API check.
- Tests: `test/setup.ts` stubs `startVerification` everywhere except the workflow tests;
  the workflow tests wait for every run they started and skip sleeps where runs would
  otherwise poll. The live DNS test reads `LIVE_DUCKDNS_TXT` and skips the DuckDNS case when
  it is unset, with no default.

**Found while building.**
- Streamdown's incomplete-markdown repair read the `_` in `_cf-custom-hostname` as an open
  italic and appended a `_` to replies. Turned off.
- The table showed "Never" checked after findings were saved, because only transitions
  pushed state. `wfRecord` and `apiCheck` now push too.
- Persisted state from before `id` existed gave React key warnings. Rebuilding state in
  `onStart` fixed it.
- `vitest.live.config.ts` had lacked the `agents()` plugin since S5, so the live DNS test
  failed to compile `@callable`. Added.
- Streamdown cannot render inside the test pool: it and `react-dom/server` load separate
  React copies there (`useId` on null). The link and image overrides are unit tested
  directly, and HTML skipping was checked in the browser.
- The "hung" lines are not from sleeping workflows, as S6 guessed. A run whose steps make
  any Durable Object call (agent or registry) logs one about 10 ms after it completes,
  even with no test helpers. With every step mocked it logs none, and a test that never
  calls a DO from a step logs none. Not fixed; see open issues.

**Checks run.**
- unit: `npm run check` (typecheck, lint, 440 tests in 17 files, build), and
  `npm run spikes` (10 tests). New: security headers on JSON, problem and history
  responses and not on the 101, the CSP directives, the `_headers` file, state rebuilt on
  start after a DO eviction, findings pushed by `wfRecord`, the https-only link and image
  overrides, and a source rule against injected HTML or remote fetches in browser code.
- live DNS: `npm run test:live-dns` without `LIVE_DUCKDNS_TXT` gives 1 passed, 1 skipped.
  With it set to the current DuckDNS TXT, 2 passed.
- live model, local production build under `vite preview`, 2026-10-06:
  - The starter prompt added `shop.example.com`; the card showed both records and the table
    row appeared live. The drawer showed findings, records and the timeline.
  - "Please delete shop.example.com" produced only the card. The dialog opened on the card's
    button, named the hostname, and Delete removed the row live.
  - The model echoed `<img>`, `<script>`, `http:`, `javascript:`, https and image-markdown
    text verbatim (read back from `get-messages`). The DOM had no `img` and no inline
    script, `http:` and `javascript:` rendered as text, and only the https link was an
    anchor with `target="_blank" rel="noopener noreferrer"`.
  - CSP, nosniff and no-referrer on the page and API responses, no CSP violations, the
    socket connected.
  - 1440 and 390: no horizontal overflow (`scrollWidth` 390). At 390 the tabs work, the
    drawer is full width with focus on Close, Tab stays inside it, and Escape returns
    focus to the row.
  - Screenshots in `docs/screenshots/`.
- deployed: not run.

**Open issues.**
- `npm test` still prints 13 "hung" lines from the workflow tests, plus 26 "User called
  terminate" and 6 "result lost after commit" lines from tests that terminate runs or fail
  steps on purpose. The "Engine was never started" and `instance.not_found` lines are gone.
  Untested idea: dispose each RPC result inside the workflow steps. That is a change to
  `src/workflow/verify.ts`, not to the tests.
- The S5 row for `ashwabh-demo.duckdns.org` is still pending with `TXT_MISMATCH` in the
  local data, as noted in S6.

## S8. Limits and observability (2026-10-06)

**Changed.**
- Daily turn quota: 30 model turns per visitor per UTC day, taken by one SQL statement
  (migration 6, `turn_quota`) after the lease and before any model call. Over it, an
  `hd_error` 429 frame with `retry_after`. The browser shows when turns reset and clears
  the pending send.
- Socket cap: 3 per visitor, counted from the SDK's connections. A 4th is accepted, then
  closed with 4429. The browser stops reconnecting (`shouldReconnectOnClose`), says "Too
  many open tabs", and explains the missing table instead of showing it empty.
- Structured JSON logs through a redaction helper (`src/observability/log.ts`):
  `api_request`, `transition` (logged after its transaction commits), `tool_call`,
  `model_call`, `workflow_step` and `dns_check`. Visitor is an HMAC of the sid.
  Correlation ids reach the agent through `AsyncLocalStorage` and, across RPC, as a
  trailing argument on the write methods and workflow callbacks.
- `GET /healthz`. Numbers moved into `limits.ts`: frame schema caps, cursor length, tool
  hostname length, DoH retries and answer name length, step-cap summary rows, secret
  length, sid and token sizes, and two UI timings.
- Test output: the app's JSON log lines are dropped by `onConsoleLog` in
  `vitest.config.ts`. `test/logs.test.ts` checks them directly.
- `docs/RUNBOOK.md`: log schema, four SLIs with how each is measured and its n, and fixes
  for a stuck pending hostname, AI quota, workflow failures and the kill switch.

**Found while building.**
- Disposing every RPC result inside the workflow steps did not remove the "hung" lines (13
  before and after). Reverted, as agreed. They are a quirk of the local Workflows engine
  under vitest: a run whose steps call a Durable Object logs one about 10 ms after it
  completes. They are not failures.
- `AsyncLocalStorage` context does carry through the SDK's chat turn into tool execution
  and the transitions it causes (asserted in `test/logs.test.ts`).
- Tool results carry no ids, so `tool_call` looks the row up with a new id-only
  `liveId()`. Reusing `findLive()` broke the per-turn memo test, which counts its calls.

**Checks run.**
- unit: `npm run check` (typecheck, lint, 460 tests in 19 files, build). New: the quota
  (30 then refused until midnight, shared across sockets, unused on 409 and kill switch,
  no model call when refused), the socket cap (4th closed with 4429, a freed place is
  reused, still enforced after the DO is evicted with sockets hibernated, separate per
  visitor), the redaction rules, log lines from a real REST call, chat turn and workflow
  run with nothing secret in them, `/healthz`, and the numeric limits rule with a planted
  value. `npm run spikes`: 10 tests in 3 files passed.
- live model, local production build under `vite preview`, 2026-10-06:
  - Four tabs of one visitor: three connected, the fourth showed "Too many open tabs" and
    the server log had exactly four upgrades, so it did not retry.
  - With the local counter set to 30 in the dev database (then removed): a message got the
    reset notice, no model call, and a `model_call` line with `quota_exceeded`.
  - One real turn ("Why is ashwabh-demo.duckdns.org not verified yet?"): `dns_check`
    (real DoH, 4 lookups), `tool_call` and `model_call` (first token 1,271 ms) under one
    correlation id and the hashed visitor, with no hostname, token or text in the lines.
- deployed: not run.

**Open issues.**
- The "hung" lines remain, now logged above as a local engine quirk.
- A refused 4th tab shows "Connected" for a moment before the 4429 close arrives, because
  the socket is accepted first.
- The SLIs are defined and measurable from logs, but have no targets yet.

## S9. Verification (2026-10-06)

**Changed.**
- Lookalike hostnames: a label may not mix scripts (UTS #39 highly restrictive: one script,
  or Latin with Han and Japanese, Chinese or Korean scripts), checked on the decoded form.
  `раypal.com` and its Punycode are refused with `mixed_script`. Whole-script lookalikes
  stay legal, so the table, drawer, tool cards and delete dialog show the `xn--` form under
  any non-ASCII name.
- Tests for `169.254.169.254`, `раypal.com` and a 300-character name over REST and through
  `add_hostname`, and the tool's 300-character argument cap.
- `eval/run.mjs` (`npm run eval:live`): drives a running server end to end with fresh
  sessions and records replies, tool calls, rows and events in `eval/results/`.
- `docs/EVALUATION.md`: six scenarios, expectations written first and left unchanged (the
  file hashed `1e9a0618...` before the runs; the expectations part is byte-identical after).
- SECURITY.md: the threat model as a results table, with model and server results apart.
- RUNBOOK.md: measured SLIs with n and provisional targets.
- Dependencies: `npm audit` in a fresh clone found 12 (10 high, 2 critical). Fixed with
  `overrides` to patched releases in the same major: `@modelcontextprotocol/sdk` 1.32.1 and
  `@modelcontextprotocol/client` 2.3.1 (pulled in by `agents`, which pins the vulnerable
  versions; the OAuth client code is bundled but never called), and dev-only `tinypool`
  2.2.0, `sharp` 0.35.5 and `undici` 7.30.0. `npm audit` now reports 0.

**Found while verifying.**
- Mixed-script hostnames were accepted (fixed above).
- The model printed the whole system prompt when asked. Accepted by design: it holds
  nothing worth stealing, as a unit test asserts. Base64 and one-character probes got less.
- In the fake SYSTEM message case the model refused but repeated the injected "The DNS
  check passed" as if true. The server changed nothing.
- Model detail gaps in the scenarios (allowed CAs not named, CNAME not called a warning,
  simulated certificates not mentioned). Recorded, prompt not changed.
- 3 of 17 first tokens took 9.6 to 11 s; one needed the retry.
- `spikes/a-tool-calls/last-run-*.json` is gitignored, so the spike A results live only in
  the S5 entry here. The SECURITY.md row cites that.

**Checks run.**
- unit: `npm run check` (typecheck, lint, 471 tests in 19 files, build).
- fresh clone: `git clone` into a temp dir outside the project, `npm ci`, `npm run check`.
  At the S8 commit: green (460 tests), with 12 audit findings. With the S9 changes applied:
  green (471 tests in 19 files, build), `npm audit` 0. No `.dev.vars` is needed.
- live model (local production build, real Workers AI and DoH, 17 turns, no quota
  errors): six scenarios, four injection prompts and seven leak probes. Results in
  `docs/EVALUATION.md`, the SECURITY.md table and `eval/results/`.
- live DNS: time to verified on `s9.ashwabh-demo.duckdns.org` (n=1). Added 23:22:41Z, TXT
  first seen over DoH 23:34:19Z, verified 23:41:16Z, active 6 ms later with a simulated
  certificate. TXT visible to verified: 6 m 56 s, set by the 10 minute backoff.
- live model, overridden dependencies: one turn after rebuilding, `model_call` ok, first
  token 1,146 ms.
- deployed: not run.

**Source size.** 12,969 non-blank, non-comment lines in 105 files (14,707 lines in all):
app 6,141, tests 5,206, spikes 827, eval runner 324, config and build 453, test fixtures 18.
Counted over `git ls-files` plus new untracked files, leaving out `docs/`, Markdown,
`LICENSE`, `package-lock.json`, the generated `env.d.ts`, `eval/results/` and images, with a
short script that drops blank lines and lines starting with `//`, `/*` or `*`:

```
{ git ls-files; git ls-files -o --exclude-standard; } | sort -u \
  | grep -vE '^docs/|^eval/results/|\.md$|^LICENSE$|^package-lock\.json$|^env\.d\.ts$|\.(svg|ico|jpg|png)$' \
  | xargs grep -cvE '^\s*$|^\s*(//|/\*|\*)' | awk -F: '{s+=$2} END {print s}'
```

**Open issues.**
- Whole-script lookalikes are accepted (ASCII form shown).
- TXT-borne instructions are tested with a scripted model only.
- The eval left background workflows polling for the eval hostnames in the local dev
  state. They stop when the server stops and are local data only.

## S10. README (2026-10-06)

**Changed.**
- README.md replaces the starter's: the problem first, what the agent does, a screenshot,
  the live URL marked pending, a five step demo, the assignment table, a Mermaid
  architecture diagram, setup, check and deploy commands, a security summary linking each
  point to SECURITY.md, engineering notes linking their evidence, guarantees and
  limitations, and credit to agents-starter. LICENSE is unchanged.
- PROMPTS.md: all 28 prompts in order, verbatim apart from removed paste markers and one
  redacted DNS verification token, each with the action taken. The automatic message that
  resumed the session after a context limit is left out.
- SECURITY.md: the lookalike rule added under "Hostname data", and `retry_after` noted on
  `hd_error` frames (both lagged S8 and S9).
- `npm-agents-banner.svg` removed. Only the starter README used it.

**Checks run.**
- unit: `npm run check` (typecheck, lint, 471 tests in 19 files, build).
- docs: all 46 relative links in README.md resolve, including anchors (script, GitHub slug
  rules). The Mermaid block parses as `flowchart-v2` with mermaid 11 under Node, and a
  malformed control input is rejected.
- Commands checked against the repo: every npm script named exists in package.json, the
  `.dev.vars` setup matches `.dev.vars.example`, and `wrangler secret put` reads stdin
  when not interactive (wrangler 4.147 source), so the deploy command never shows the
  secret.
- deployed: not run. Deploy is S11.

**Open issues.**
- The live URL is a placeholder until S11. PROMPTS.md will be regenerated after deploy.

## S11. Deploy (2026-10-07)

**Deployed.** https://hostname-doctor.bhatnagarashwabh.workers.dev at 2026-10-07T00:08:57Z,
Worker version `607582d9-ca5b-4ceb-86cb-27e3c971c689`, from commit `09b325e` (S10 plus the
`/healthz` fix below). Account: the logged-in account, nothing else on it touched,
bought or upgraded. First deploy of `hostname-doctor`.

**Before deploying.**
- `npm run check` (471 tests then 472, build), `npm run spikes` (10), `npm audit` 0.
- `wrangler deploy --dry-run` showed both Durable Objects (migration `v1`, the only one),
  the workflow, AI, three rate limits and production vars only: the workers.dev origin,
  `COOKIE_DEV_MODE=false`, `AI_KILL_SWITCH=false`. The `.dev.vars` copy in `dist/` is not
  uploaded. No test, fixture or spike code in the bundle. 843 KiB gzipped.
- Found and fixed: `/healthz` was not in `assets.run_worker_first`, so the assets layer
  answered it with `index.html` (200) and the Worker never ran. Added, with a config test
  that every path the router serves is covered (fails without the fix). Commit `09b325e`.
- `SESSION_SECRET`: generated in a pipe straight into `wrangler secret put`, never shown or
  written. Wrangler created an empty draft Worker first, its default for a new name.
- Deploy: `npm run deploy`. The new workers.dev name took about 3 minutes to start
  answering; the first smoke attempt got `ECONNRESET` before that.

**Smoke tests (deployed, 2026-10-07 00:12 to 00:17 UTC).**
- Assets: `/` 200 with the CSP (including `connect-src` for our `wss`), nosniff,
  no-referrer, no inline script; the app bundle and `/theme.js` 200.
- `/healthz`: 200 `{"status":"ok"}`, `application/json`, `no-store`, no cookie.
- Session: 204, `no-store`, cookie `__Host-hd_sid` with `Path=/; Secure; HttpOnly;
  SameSite=Lax`, no `Domain`. Value never printed.
- Wrong origin: POST from `https://evil.example`, from `http://localhost:5173` and with no
  Origin all 403 problem JSON (so no local value reached production). Upgrade from
  `https://evil.example` 403; from our origin 101.
- Hostname: `www.example.com` created 201 `pending` with records and an ETag; `/check` 200
  with `TXT_MISSING`, `CNAME_MISSING`. Its workflow run is running in production.
- Chat (live model): "Why is www.example.com not verified yet?" called `explain_findings`
  and named the exact TXT and CNAME records. First output 2,362 ms at the client, 2,165 ms
  in `model_call`, total about 7 s.
- Logs (`wrangler tail`): `api_request`, `transition`, `dns_check`, `tool_call` and
  `model_call` lines with the hashed visitor and one correlation id per turn. No cookie
  value anywhere in the tail. The capture was deleted afterwards.

**Found in the smoke test.**
- **ETag weakened at the edge.** Cloudflare compresses JSON responses and turns our strong
  ETag header into `W/"..."`, so a client that sends the header back in `If-Match` gets 412
  and `If-None-Match` never gives 304. Not seen locally, where nothing compresses. The
  `etag` field in the body is unchanged, and a delete with it worked (202, `deleted`). The
  UI is not affected: its delete uses the ETag from the card. Not fixed in this stage.
- The cleanup delete of the smoke hostname got that 412, and its session cookie was not
  kept, so `www.example.com` stays `pending` for that anonymous visitor. Its workflow gives
  up after 24 hours and the row ends `failed`. A second probe hostname was deleted with
  the body ETag, which terminated its workflow.
- Workflow step logs did not appear in `wrangler tail`. The instance list shows the runs.
- Wrangler enabled Preview URLs by default because `preview_urls` is not set. Writes there
  are refused (origin not allowed), but reads work.

**Checks run.** unit (above); deployed (above). Browser test on the live URL: pending, by
the user.

**Open issues.**
- Accept a weak ETag in `If-Match` and `If-None-Match` (compare without `W/`), then redeploy.
- Decide on `preview_urls`.
- PROMPTS.md to be regenerated after deploy.

**Follow-up: strong ETags and Preview URLs (2026-10-07).**
- Every `/api/*` response now sends `Cache-Control: no-store, no-transform`, set in one
  place in the router, so the edge no longer compresses API JSON and the ETag stays as
  written. Static assets are still compressed. `"preview_urls": false` in `wrangler.jsonc`.
- unit: 475 tests in 19 files. New: `no-store, no-transform` on 201, 200, 304, 404 and the
  session 204; the header ETag round-trips through `If-None-Match` (304) and `If-Match` (202);
  `preview_urls` is false. Removing the router change makes the first test fail.
- Commit `b3693d5`, deployed 2026-10-07T01:12:46Z, version
  `c1f55fc6-e755-442d-ad66-bbecf5e8ded0`. No Preview URLs warning on deploy.
- deployed, rechecked with `accept-encoding: gzip, br` on a fresh probe hostname: API responses
  not compressed, ETag strong and equal to the body's, `If-None-Match` 304, `DELETE` with the
  header ETag 202 `deleted` (which removed the probe). `/` still served with `br`. The Preview
  URLs for both versions return 404.
- The `W/` tolerance fallback was not needed and was not added.
- Still open: the S11 smoke row `www.example.com` ends `failed` after 24 hours; PROMPTS.md to
  be regenerated; the user's browser test.

## Manual live test and card fix (2026-10-07)

**Manual checks by the user on the deployed URL, 2026-10-07: all passed.**
- The app loads and shows Connected. "what is a caa record" was answered with no tool card.
- Added `live.ashwabh-demo.duckdns.org`, set the TXT, and it went pending to active live in
  the table, with only `CNAME_MISSING` left.
- A private window had its own empty workspace.
- Delete showed the card and no dialog by itself; the dialog named the hostname, and the
  row disappeared live.
- The dashboard showed all bindings, the secret's name, redacted JSON logs and the workflow
  instances.

**Fix: the add card showed a stale state.** Chat tool cards showed the state the tool
returned, so the add card still said pending after the hostname went active. Cards now
show the hostname's state from the live table the server pushes. Once the hostname is gone
they show the old state labeled "when added" (add) or "at the time" (other tools).
- unit: 478 tests in 20 files. New: `cardState` picks the live state, falls back with the
  label, and shows nothing for unknown states. The rendered card cannot be tested in the
  pool (Kumo hooks, the same two-React problem as S7), so it was checked live.
- Commit `b30721c`, deployed 2026-10-07T03:11:00Z, version
  `710251d1-4361-427a-b4d0-5294a5570458`. `/healthz` and `/` 200 afterwards.
- deployed, in the browser pane as a fresh visitor: the starter prompt added
  `shop.example.com` (one live turn); the card's badge matched the table. Asked to delete
  it: card only, the dialog named the hostname, Delete removed the row. The old add card
  then read "Pending when added". The throwaway row is gone and its workflow stopped.
- New README screenshot from the live app: `docs/screenshots/live-1440.jpg`.

**Still open.** PROMPTS.md to be regenerated now that deploy is done. The S11 smoke row
`www.example.com` ends `failed` after 24 hours.
