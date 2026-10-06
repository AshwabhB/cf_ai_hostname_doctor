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
| `/agents/<any other class>/*` | any | n/a | n/a | n/a | n/a | Rejected with 403 |
| `OPTIONS *` | OPTIONS | n/a | n/a | n/a | n/a | Rejected with 403. No CORS anywhere |
| anything else | any | n/a | Exact match for non-GET | n/a | 16 KiB declared body (413) | 404 |

Allowed origins come from `ALLOWED_ORIGINS`:
`https://hostname-doctor.bhatnagarashwabh.workers.dev` and `http://localhost:5173`.
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
| `rpc` | 403 unless the method is in `CALLABLES` in `src/security/frames.ts` (empty until S5), then its argument schema applies |
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
