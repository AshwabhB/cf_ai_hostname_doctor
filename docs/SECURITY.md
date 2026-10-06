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
