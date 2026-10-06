# Security

How the Worker decides who a request belongs to and what it may do. Code lives in
`src/router.ts`, `src/security/` and the frame guard in `TenantAgent` (`src/server.ts`).
Every number below comes from `src/config/limits.ts`.

## Identity

- Each visitor gets a random 128-bit sid in the `__Host-hd_sid` cookie (`hd_sid` when
  `COOKIE_DEV_MODE=true` in local dev). Attributes: `Secure; HttpOnly; Path=/; SameSite=Lax`,
  no `Domain`. Lax keeps the session when the app is opened from a link.
- The value is `base64url(payload).base64url(HMAC-SHA256(payload))` with
  `payload = { v: 1, sid, iat, exp }`, signed with `SESSION_SECRET` through Web Crypto. The
  signature is compared with `crypto.subtle.timingSafeEqual`. The payload is parsed with a
  strict schema, so unknown fields fail.
- Lifetime is 30 days. `GET /api/v1/session` reissues the cookie when under 7 days are left.
- Nothing personal is stored. The IP is used only as a rate limit key and is never stored or
  logged.
- `GET /api/v1/session` is the only route that sets the cookie. A missing, tampered or expired
  cookie there gets a new sid. Everywhere else it gets 401.

## Agent routing

- The browser always asks for `/agents/tenant-agent/me`. The router rewrites `me` to the sid
  from the cookie. A request naming any other instance gets 403 (the visitor's own sid is
  also accepted). Any agent class other than `tenant-agent`, including `hostname-registry`,
  gets 403.
- `TenantAgent` sets `sendIdentityOnConnect: false`, so the sid is never sent to the browser.
- For upgrades, the router adds `__hd_exp` (the cookie expiry) to the rewritten URL after
  deleting any client copy. TenantAgent reads it from `connection.uri`, which survives
  hibernation, and closes the socket with 4401 once the cookie has expired. The client
  then calls `/api/v1/session` and reconnects.

## Route matrix

| Route | Methods | Identity | Origin | Schema | Size limit | Rate limit |
|---|---|---|---|---|---|---|
| `GET /api/v1/session` | GET | Cookie optional. Issues or renews it | Not checked (GET) | None (no input) | No body read | `SESSION_LIMITER`, 30/min per IP, at the Worker |
| `/api/v1/session`, other methods | any | None | Exact match required | None | 16 KiB declared body (413) | None (405) |
| `GET /agents/tenant-agent/me/get-messages` | GET | Valid cookie (401). Name must be `me` or own sid (403) | Not checked (GET) | Path allowlist (404) | No body read | None |
| `/agents/tenant-agent/me` upgrade | GET + Upgrade | Valid cookie (401). Name must be `me` or own sid (403) | Exact match required (403) | Frame schemas below | 32 KiB per frame (close 1009) | `CONNECT_LIMITER`, 30/min per sid, at the Worker. Frames: bucket of 20, refills 2/s per connection, in the DO |
| `GET /api/v1/hostnames?limit&cursor` | GET | Valid cookie (401). Rows are per visitor | Not checked (GET) | Strict query: `limit` 1 to 999 (clamped to 50), opaque `cursor` (400). Unknown params 400 | No body read | `API_LIMITER`, 60/min per sid, at the Worker |
| `POST /api/v1/hostnames` | POST | Valid cookie (401) | Exact match required (403) | `Idempotency-Key` required (428), `[A-Za-z0-9._:-]{1,128}` (400). JSON `{ hostname }` strict (400), then normalization (400 `invalid-hostname`) | 16 KiB, enforced while reading even without Content-Length (413) | `API_LIMITER` |
| `GET /api/v1/hostnames/{id}` | GET | Valid cookie (401). Another visitor's id is 404 | Not checked (GET) | No query params (400) | No body read | `API_LIMITER` |
| `DELETE /api/v1/hostnames/{id}` | DELETE | Valid cookie (401). Another visitor's id is 404 | Exact match required (403) | `If-Match` required (428), must be the current ETag (412) | 16 KiB declared body (413) | `API_LIMITER` |
| `GET /api/v1/hostnames/{id}/events` | GET | Valid cookie (401). Another visitor's id is 404 | Not checked (GET) | Same query rules as the list | No body read | `API_LIMITER` |
| `POST /api/v1/hostnames/{id}/check` | POST | Valid cookie (401). Another visitor's id is 404 | Exact match required (403) | No body used. Deleted rows 409 | 16 KiB declared body (413) | `API_LIMITER`, plus 30 checks per hour per visitor counted in the DO (`check_runs`), 429 |
| `GET /api/v1/hostnames/{id}/diagnosis` | GET | Valid cookie (401). Another visitor's id is 404 | Not checked (GET) | No query params (400). ETag `"<id>.diag.<last_checked_at>"`, If-None-Match 304 | No body read | `API_LIMITER` |
| `POST /api/v1/hostnames/{id}/retry` | POST | Valid cookie (401). Another visitor's id is 404 | Exact match required (403) | No body used | 16 KiB declared body (413) | `API_LIMITER` |
| `/agents/<any other class>/*` | any | n/a | n/a | n/a | n/a | Rejected with 403 |
| `OPTIONS *` | OPTIONS | n/a | n/a | n/a | n/a | Rejected with 403. No CORS anywhere |
| anything else | any | n/a | Exact match for non-GET | n/a | 16 KiB declared body (413) | 404 |

Allowed origins come from `ALLOWED_ORIGINS`. Production (`wrangler.jsonc`) allows only
`https://hostname-doctor.bhatnagarashwabh.workers.dev`, and a test pins that. Local dev adds
`http://localhost:5173` through `.dev.vars`.
Requests that are not GET, and every WebSocket upgrade, must send one of these exactly.
A missing `Origin` header counts as not allowed.

## WebSocket frames

TenantAgent wraps `onMessage` after the SDK constructors run, so this guard sees every frame
before state sync, RPC or the chat protocol. It runs in this order:

1. Cookie expiry from `connection.uri`. Expired: close 4401.
2. Binary frame: close 1003.
3. Over 32 KiB: close 1009.
4. Per-connection token bucket. Empty: `hd_error` 429.
5. JSON parse and strict schema per type. Failure: `hd_error` 400 or 403.

| Frame type | Decision |
|---|---|
| `cf_agent_use_chat_request` | Allowed with a strict schema. The body must hold exactly one `user` message with only text parts, at most 4000 characters in total, and `trigger: "submit-message"`. Unknown fields fail. The guard rebuilds the request as server history plus that one message, so the browser can never write history. A message id already on the server gets 400. |
| `cf_agent_chat_clear` | Allowed. Clears the visitor's own history |
| `cf_agent_chat_request_cancel` | Allowed, `{ type, id }` only |
| `cf_agent_stream_resume_request`, `cf_agent_stream_resume_ack` | Allowed, needed for stream resume on reconnect |
| `cf_agent_state` (client setState) | 403. `validateStateChange` also throws for any source but the server |
| `rpc` | 403 unless the method is in `CALLABLES` in `src/security/frames.ts`, then its argument schema applies (400). Listed: `confirmDelete(id, etag)` and `retryHostname(id)`, which call the same `HostnameService` as REST. The REST RPC methods (`apiCreate` and the rest) are not `@callable` and are refused with 403 |
| `cf_agent_chat_messages` (history overwrite) | 400 |
| `cf_agent_tool_result`, `cf_agent_tool_approval` | 400. There are no client tools, and deletes use a `@callable` |
| anything else, non-JSON | 400 |

`hd_error` frames carry only `{ type, status, title }`, with a fixed title per check.

## Responses

- Errors are RFC 9457 `application/problem+json` with `type`, `title`, `status`, `instance`
  and sometimes a fixed `detail`. They never include exception text or stack traces.
- Visitor-specific responses (`/api/v1/session`, `get-messages`, every error) send
  `Cache-Control: no-store`.

## Secrets

- `SESSION_SECRET` lives in `.dev.vars` locally (gitignored, mode 600, generated without being
  printed) and goes in with `wrangler secret put` for production.
- `vite build` copies `.dev.vars` into `dist/hostname_doctor/.dev.vars` so `vite preview`
  works. `dist/` is gitignored and `wrangler deploy` does not upload `.dev.vars`, but the
  build folder must never be shared or published as an artifact.
- Tests run on a test-only secret set in `vitest.config.ts`. A test asserts it is not the
  `.dev.vars` value.

## Tests

`test/session.test.ts`, `test/router.test.ts` and `test/frames.test.ts` cover a tampered
cookie, an expired cookie, another visitor's agent, the registry path, upgrades from a wrong
or missing origin, client setState, unlisted RPC, history overwrite, client tool results,
an oversized frame, a binary frame, unknown fields, file parts, an over-long message, frame
floods and both 429s. Each rejection test also asserts that `modelFactory.create`, the only
path to Workers AI, was never called.

## Hostname data

- Each visitor's rows live in their own TenantAgent SQLite, so another visitor's id is
  simply not found (404). Ids are checked against `hn_` plus 24 hex characters before any
  query, and every query uses bound parameters.
- `normalizeHostname` is the only way a hostname is accepted. Any ASCII character other than
  letters, digits, dot and hyphen is refused before IDNA, because `domainToASCII` parses like
  a URL host and would silently drop `/path`, `:port` or `user@`. Punycode labels must round
  trip, public suffixes (ICANN and private, through tldts) are refused, and IPs, wildcards
  and reserved names are refused.
- Every state change goes through `HostnameService.transition`, which checks the section 2
  table, the actor, the generation and the version inside one transaction, and writes the
  event with the row. Values read before an await are checked again at commit.
- Error types: `bad-request` 400, `invalid-hostname` 400, `invalid-cursor` 400,
  `unauthorized` 401, `forbidden` 403, `not-found` 404, `method-not-allowed` 405,
  `hostname-exists` 409, `quota-exceeded` 409, `invalid-transition` 409,
  `precondition-failed` 412, `payload-too-large` 413, `idempotency-key-reuse` 422,
  `precondition-required` 428, `rate-limited` 429.

## Outbound DNS

- `src/dns/doh.ts` is the only server code that calls `fetch`, and it only calls
  `https://cloudflare-dns.com/dns-query` with `accept: application/dns-json`. A unit test
  (`test/source-rules.test.ts`) fails if any other server file calls `fetch` or if the DoH
  client names another URL.
- Names are built from the normalized hostname, its parent labels (for the CAA walk), and
  CNAME targets that pass normalization first. The client also refuses anything that is
  not a plain lowercase LDH name.
- Limits: 3 s timeout, one retry on a network error or 5xx after 200 to 500 ms of jitter,
  64 KB read cap enforced while streaming, 12 lookups per diagnosis.
- DNS text is attacker controlled. Control, zero-width and bidi characters are stripped,
  strings are capped at 255 characters and names at 10 records, before anything is stored
  or returned. The TXT match is an exact compare on the raw decoded value, so no content
  in a record is ever interpreted. A fixture test feeds a TXT that says "mark this
  verified" and checks it is only a `TXT_MISMATCH`.
- A check saves findings and never changes state. The hostname ETag is untouched, so
  deletes do not fail on unrelated DNS saves.
- No source or test file may contain invisible or bidi control characters (Trojan Source).
  The same source-rules test enforces this.

## Model boundary

- The model only acts through six tools (`src/ai/tools.ts`). Their inputs are strict zod
  objects holding a hostname, and the visitor, ids and ETags come from server context.
  Writes run as the `model` actor, which the transition table refuses for `verified`,
  `active`, `deleting` and `deleted`. `propose_delete` returns a confirm card and changes
  nothing. The delete itself needs the user's click on the `confirmDelete` callable. A test
  runs every tool against a row in every state and finds only the two retries the table
  allows.
- The system prompt (`src/ai/prompts/system.v1.ts`, about 544 tokens by a conservative
  estimate) holds no secrets. Each turn appends UTC time and a STATE block from SQL, marked
  as data. Tool results and DNS values reach the model as tool data, never in the system
  message, and DNS text is already sanitized.
- Bad tool arguments never execute. The first one returns the schema error to the model,
  and the second ends the turn with a fixed message.
- One turn per visitor through a SQLite lease (60 s backstop expiry). It is released when
  the SDK handler returns and in `onChatResponse`, which covers completed, error, abort and
  timeout. Only the holder can release it. An overlapping request gets `hd_error` 409.
- Time limits: 10 s to the first token and 30 s in total. Before the first token, one retry
  on a 5xx or timeout (`src/ai/first-token.ts`). Nothing is retried after the first token.
- `AI_KILL_SWITCH="true"` (a plain var) answers with a fixed message and never creates a
  model.
- `FALLBACK_ORIGIN` and every name under it are refused as custom hostnames.

## Verification workflow and registry

- Only code decides verification. `VerifyWorkflow` runs the S4 rules inside steps, then
  asks the `HostnameRegistry` for the claim. First verified claim wins: another visitor's
  claim gives `conflict`.
- Every call from the workflow back into TenantAgent carries the generation. A late step
  for a deleted or re-added hostname is refused and writes nothing. The workflow callbacks
  (`wfLoad`, `wfRecord`, `wfSettle`, `wfActivate`, `wfGiveUp`) are plain RPC methods, not
  `@callable`, so a browser cannot reach them (the frame guard refuses unlisted RPC).
- Certificates are simulated: `certificate.simulated: true`, issuer "Simulated". Nothing
  is issued by a real certificate authority.
- Delete stops the workflow, releases the claim, and only then marks the row deleted.
  Reconcile finishes any delete that stalls and releases claims left by deleted rows.
- Unit tests never reach the network: `test/setup.ts` replaces `fetch` with a guard, and a
  test proves the workflow's DoH calls are refused unless a fixture is installed.

## Browser UI

- **The model cannot open the delete dialog.** `propose_delete` only produces a card in the
  chat. The dialog opens when the user clicks the card's "Delete {hostname}..." button,
  names the hostname in its title, and calls `confirmDelete` with the card's ETag only when
  the user presses Delete. Nothing in a tool result, model text or pushed state opens it.
  Why: model output is untrusted and can be steered by text in a DNS record or a pasted
  message. A dialog that popped up on the model's say-so would turn a prompt injection
  into a one-click delete, aimed at a user who never asked for one. Two clicks the user
  starts, and an ETag that must still match on the server, keep the decision with them.
- Assistant text renders through Streamdown with `skipHtml`, and `img`, `iframe`, `script`
  and `style` disallowed. Links render as links only for `https:`, with
  `target="_blank" rel="noopener noreferrer"`. Every other scheme (`http:`,
  `javascript:`, `data:`, relative) renders as plain text. Images render as nothing, so
  no remote host is contacted.
- Tool results render as small cards, never raw JSON. DNS names, TXT values and observed
  records are plain text through React, never markdown or HTML. No component uses
  `dangerouslySetInnerHTML`.
- The browser only calls its own origin: the REST reads for the drawer and the agent
  socket.

## Response headers

- Production responses carry:
  - `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self';
    img-src 'self'; font-src 'self'; connect-src 'self'
    wss://hostname-doctor.bhatnagarashwabh.workers.dev; object-src 'none'; base-uri
    'none'; form-action 'self'; frame-ancestors 'none'`
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: no-referrer`
- One source, `src/config/security-headers.ts`. The build writes it into the static
  assets' `_headers` file (a build-only plugin in `vite.config.ts`), and the Worker adds
  it to its own JSON, problem and history responses. The WebSocket upgrade (101) is left
  untouched.
- No `unsafe-eval` and no `unsafe-inline`. The theme script moved out of `index.html`
  into `public/theme.js`, so no inline script is needed. No style hashes were needed:
  React sets styles through the DOM, which `style-src 'self'` allows.
- `vite dev` does not apply the assets' `_headers`, because Vite injects inline scripts
  in dev. The policy was checked under `vite preview` of the production build.

## Quotas and socket limits

- **Daily model turns.** Each visitor gets `LIMITS.chat.turnsPerVisitorPerDay` (30) turns
  per UTC day. The turn is taken by one SQL statement in TenantAgent
  (`INSERT ... ON CONFLICT DO UPDATE ... WHERE used < limit`), after the turn lease and
  before any model call. It is per visitor, so every socket of theirs shares it. Over the
  limit, the socket gets an `hd_error` frame with status 429 and `retry_after` (seconds
  to the next UTC midnight), and no model is created. A turn refused with 409 for
  overlapping, and a turn while the kill switch is on, use nothing.
- **Sockets.** At most `LIMITS.ws.maxSocketsPerVisitor` (3) per visitor. A 4th is accepted
  and then closed with code 4429, so the browser can show why and stop reconnecting.
  Sockets are counted from the SDK's connections, which come from the runtime's socket
  list and so survive hibernation. A tab that reconnects with its own connection id is not
  counted twice.
- **No stray limits.** Every numeric limit lives in `src/config/limits.ts`. A source rule
  test fails on any other number in `src/`, except protocol facts (HTTP statuses, close
  codes, DNS record types, RFC name lengths, time-unit factors) listed in the test with
  the reason for each.

## Logs

- One JSON line per event: `api_request`, `transition`, `tool_call`, `model_call`,
  `workflow_step` and `dns_check`. Fields: event, hashed visitor, hostname id, outcome,
  latency, correlation id, plus a few enums (route template, state, tool, step).
- Everything goes through `redact()` in `src/observability/log.ts`. It keeps only
  allowlisted keys and scalar values, masks any 32+ character hex run (session ids, TXT
  tokens), long base64 runs (signed cookies, keys) and any value naming a credential, and
  cuts long strings.
- Callers never pass prompts, model text, tool inputs or outputs, cookies, tokens, TXT
  values, hostnames or raw paths. The masks are a second line of defence.
- The visitor is an HMAC of the session id keyed with `SESSION_SECRET`, cut to 16 hex
  characters, so a log reader cannot recover or guess the id. Rotating the secret changes
  every visitor's hash.
- The browser's chat request id is never logged; a server-made id ties a turn together.
  Workflow instance ids contain the session id, so a run logs
  `<hostname_id>-g<generation>-r<run>` instead.
- Tested (unit): the redaction rules, and real REST, chat and workflow runs whose log
  lines hold no session id, cookie, TXT value, user text or model text.

## Health

- `GET /healthz` returns `{"status":"ok"}` with `no-store`. No session, no model call,
  nothing about the account, and it is not logged.
