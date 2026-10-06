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
