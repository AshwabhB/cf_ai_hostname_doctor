# Design

An AIChatAgent that helps a SaaS team add a custom hostname, see why DNS is not ready, and
remove it. Code decides verification. The model explains findings and calls tools.

## 1. Actors

| Actor  | Who                                              | Reaches the server via            |
|--------|--------------------------------------------------|-----------------------------------|
| user   | the visitor in the browser                       | REST v1, @callable on TenantAgent |
| model  | Llama 3.3 70B fp8-fast inside the chat loop      | tools only                        |
| system | DNS rules engine, VerifyWorkflow, registry, alarms | internal RPC                    |

## 2. Hostname state machine

States: `pending`, `verified`, `active`, `failed`, `conflict`, `deleting`, `deleted`.
`deleted` is terminal. Re-adding a hostname creates a new row with a new generation.

| From                                         | To        | Who    | Condition                                          |
|----------------------------------------------|-----------|--------|----------------------------------------------------|
| (none)                                       | pending   | user, model | valid hostname, under quota, no live row for it |
| pending                                      | verified  | system | rules engine passes AND registry claim granted     |
| pending                                      | conflict  | system | rules pass but registry owned by another tenant    |
| pending                                      | failed    | system | max attempts or deadline reached                   |
| verified                                     | active    | system | simulated certificate issued                       |
| failed, conflict                             | pending   | user, model | explicit retry; starts a new workflow run     |
| verified, active                             | conflict  | system | reconcile finds registry owner is someone else     |
| pending, verified, active, failed, conflict  | deleting  | user   | confirm click (@callable) or REST DELETE with If-Match |
| deleting                                     | deleted   | system | registry released (or never held) for this generation |

Every other pair is rejected with 409 `invalid-transition`. One function,
`transition(row, to, actor, expected)`, enforces the table, does compare-and-set on
`(generation, state, version)`, bumps `version`, and writes an `events` row in the same
SQL transaction. The model actor has no path to `verified`, `active` or `deleting`.

## 3. Durable Objects

**TenantAgent** (extends AIChatAgent), one per visitor.
- Name is derived on the server from the signed visitor cookie (HMAC, secret in env).
  The router ignores any agent name the client sends and rejects a mismatch with 403.
- Owns the visitor's hostname rows, events, idempotency keys, DNS cache and chat history.
- Exposes RPC for the workflow (`getRow`, `applyFindings`, `transition`) and @callable
  methods for the browser (`confirmDelete(id, etag)`, `retry(id)`).

**HostnameRegistry**, one per normalized hostname (`idFromName(hostname)`).
- Holds `next_generation`, and `owner_tenant` plus `owner_generation` or null.
- `register(tenantId)` returns a fresh generation. Monotonic, never reused.
- `claim(tenantId, generation)`: grants if no owner, or if the owner already is this
  tenant and generation. Otherwise returns the current owner as `conflict`. First verified
  claim wins, because claim is only called after the rules engine passes for that tenant's
  own TXT token.
- `release(tenantId, generation)`: clears ownership only if it matches. Otherwise no-op.

**Generation.** Every row, workflow param, finding and claim carries `generation`.
Every write checks it. A late step from a deleted and re-added hostname sees a mismatch
and exits without writing.

## 4. SQL (TenantAgent SQLite)

```
hostnames(id PK, hostname, generation, state, version, verify_token,
          findings_json, attempts, workflow_instance_id, created_at, updated_at, last_checked_at)
  UNIQUE (hostname) WHERE state <> 'deleted'  -- create: reject a duplicate live row
  INDEX (created_at, id)                       -- list: cursor paging, newest first
  INDEX (state, last_checked_at)               -- reconcile: find stale pending or deleting rows

events(id INTEGER PK, hostname_id, generation, from_state, to_state, actor, reason, at)
  INDEX (hostname_id, id)                      -- timeline for one hostname, also for audit tests

idempotency_keys(key PK, request_hash, status, response_json, created_at)
  INDEX (created_at)                           -- sweep keys older than the TTL

dns_cache(name, rrtype, answer_json, fetched_at, expires_at, PRIMARY KEY (name, rrtype))
  INDEX (expires_at)                           -- evict expired answers
```

HostnameRegistry has one table: `ownership(next_generation, owner_tenant, owner_generation, updated_at)`.

## 5. REST API v1

All routes are under `/api/v1`, scoped to the cookie's tenant. State-changing requests
require a same-origin `Origin` header.

| Method | Path                         | Notes                                                   |
|--------|------------------------------|---------------------------------------------------------|
| POST   | /hostnames                   | `Idempotency-Key` required (428 if missing). 201, `Location`, `ETag` |
| GET    | /hostnames?limit&cursor      | `{ items, next_cursor }`. Cursor is opaque, encodes `(created_at, id)` |
| GET    | /hostnames/{id}              | `ETag: "<id>.<version>"`. `If-None-Match` gives 304     |
| GET    | /hostnames/{id}/events       | cursor paged                                            |
| POST   | /hostnames/{id}/retry        | allowed from `failed` or `conflict` only                |
| DELETE | /hostnames/{id}              | `If-Match` required (428). Stale gives 412. 202 then `deleting` |

Paging: `limit` defaults to 20 and is capped at 50 (`LIMITS.paging` in limits.ts).

Idempotency: same key and same body hash replays the stored response. Same key with a
different body gives 422 `idempotency-key-reuse`. Keys expire after the TTL in limits.ts.

Errors are RFC 9457 `application/problem+json` with `type`, `title`, `status`, `detail`,
`instance`. Types: `invalid-hostname`, `not-found`, `quota-exceeded`, `invalid-transition`,
`precondition-required`, `precondition-failed`, `idempotency-key-reuse`, `rate-limited`,
`invalid-cursor`, `forbidden`. Unknown routes and methods also return problem JSON.

## 6. VerifyWorkflow

Params: `{ tenantId, hostnameId, hostname, generation, run }`. Instance id is
`${tenantId}.${hostnameId}.${generation}.${run}`, so a duplicate start fails and is
treated as "already running". The workflow holds no state of its own.

| Step                | Does                                                   | Safe to run twice because                          |
|---------------------|--------------------------------------------------------|----------------------------------------------------|
| `load`              | read row; exit if missing, wrong generation, not pending | read only                                         |
| `dns-${i}`          | DoH lookups, rules engine, returns findings            | read only; step result is cached by name           |
| `record-${i}`       | `applyFindings(id, generation, i, findings)`           | upsert keyed on `(generation, i)`; generation guard |
| `claim`             | `registry.claim(tenantId, generation)`                 | same tenant and generation returns the same result |
| `settle`            | CAS pending to verified or conflict                    | CAS on `(generation, state)`; second run is a no-op |
| `activate`          | simulated cert, CAS verified to active                 | CAS; cert record keyed on generation               |
| `sleep-${i}`        | backoff from limits.ts                                 | durable sleep                                      |
| `give-up`           | CAS pending to failed after max attempts               | CAS                                                |

Delete runs in TenantAgent: CAS to `deleting`, then `registry.release`, then CAS to
`deleted`. An alarm retries until it succeeds. Release and both CAS steps are idempotent.

### Reconcile

TenantAgent is the source of truth for its rows. The registry is the source of truth for
ownership. A reconcile pass runs on a TenantAgent alarm (interval in limits.ts) and on retry.

| Disagreement                                              | Action                                       |
|-----------------------------------------------------------|----------------------------------------------|
| row verified or active, registry owner is someone else    | system transition to `conflict`              |
| registry owned by this tenant, row deleted or newer generation | `registry.release(tenantId, oldGeneration)` |
| row pending, workflow errored, terminated or missing      | start run `run + 1`                          |
| row deleting longer than the threshold                    | retry release, then CAS to deleted           |
| workflow step writes with an old generation               | rejected by the guard, logged, no change     |

## 7. DNS rules

Resolution uses DNS over HTTPS (`https://cloudflare-dns.com/dns-query`, JSON), the only
outbound fetch in the code, with the `dns_cache` table. Limits live in limits.ts: 3 s timeout,
one retry on a network error or 5xx with 200 to 500 ms jitter, 64 KB read cap, 12 lookups
per diagnosis. Answers are cached for min(TTL, 60 s), SERVFAIL for at most 10 s, timeouts not
at all. Only normalized hostnames are looked up.

Rules are pure functions from the lookup results to findings:
`{ code, severity, record, expected, observed, message }`. Severity is `error`, `warning`
or `info`. A hostname is verifiable only when no finding is an `error`, computed by
`isVerifiable(findings)` in code.

| Code | Severity | When |
|---|---|---|
| `TXT_MISSING` | error | No TXT at `_cf-custom-hostname.<hostname>` |
| `TXT_MISMATCH` | error | TXT records exist but none equals the tenant's token |
| `TXT_MULTIPLE` | warning | One TXT matches and others are also present |
| `CNAME_MISSING` | warning | No CNAME at the hostname |
| `CNAME_WRONG_TARGET` | warning | The CNAME chain (up to 3 hops) never reaches `FALLBACK_ORIGIN` |
| `APEX_CNAME` | info | The hostname is a registrable domain, which cannot hold a CNAME. Suggests CNAME flattening or ALIAS to `FALLBACK_ORIGIN`. CNAME checks are skipped |
| `NXDOMAIN` | warning | The hostname itself does not exist |
| `CAA_BLOCKS` | error | The first non-empty CAA set walking up from the hostname (RFC 8659) has `issue` tags and none allows `letsencrypt.org`, `pki.goog` or `ssl.com`, or it has an unknown critical tag |
| `SERVFAIL`, `DNS_TIMEOUT`, `DNS_ERROR` | error for the TXT and CAA lookups, warning for CNAME | The lookup failed, timed out, or returned an oversized or malformed answer, or the lookup budget ran out |

TXT proves ownership. The CNAME only routes traffic, which is why CNAME findings are
warnings, as in Cloudflare for SaaS.

- Expected records: TXT at `_cf-custom-hostname.<hostname>` holding the tenant's token, and
  a CNAME from `<hostname>` to the `FALLBACK_ORIGIN` var
  (`hostname-doctor.bhatnagarashwabh.workers.dev`).
- Hostname normalization (S3): trim, lowercase, strip a trailing dot, UTS #46 to punycode,
  253 characters and 63 per label, letters, digits and hyphens with no hyphen at a label
  edge, at least two labels. IPs, wildcards, reserved suffixes (`.test`, `.invalid`,
  `.example`, `.local`, `.internal`, `.localhost`) and bare public suffixes are refused.
- TXT match is an exact string compare against the tenant's own token. Nothing else in a
  TXT value is interpreted.
- DNS text is attacker controlled. Before it is stored or shown, control, zero-width and bidi
  characters are stripped, each string is capped at 255 characters and each name at 10
  records. It is data only.
- `POST /hostnames/{id}/check` runs a diagnosis and saves findings and `last_checked_at`
  without changing state (30 per hour per visitor). `GET /hostnames/{id}/diagnosis` returns
  them with an ETag built from `last_checked_at`, so the hostname ETag changes only on
  transitions. State changes on DNS results are the workflow's job (S6).
- The model gets finding codes plus sanitized `observed` values wrapped as quoted data. It
  never gets to decide pass or fail.

## 8. Chat agent

- `onChatMessage` calls `streamText` with the system prompt, `pruneMessages` output, the
  tool set and a step limit from limits.ts. Built-in resumable streaming handles reconnects.
- Tools: `list_hostnames`, `get_hostname`, `add_hostname`, `retry_hostname`,
  `explain_findings`, `propose_delete`. All take schema-validated args and act only on the
  current tenant's rows.
- `propose_delete` changes nothing. It returns a card. The browser shows a Confirm button
  that calls the `confirmDelete` @callable with the row's ETag. The model has no tool that
  reaches it.
- A malformed tool call returns a structured error to the model and counts toward the step
  limit. It never throws past the tool layer.

## 9. Threat model

| Threat                         | Boundary                         | Control                                                        | Test |
|--------------------------------|----------------------------------|----------------------------------------------------------------|------|
| Bad visitor (spam creates, enumeration, claiming another tenant's hostname) | Worker router, TenantAgent, registry | per-visitor rate limit and quota; per-tenant TXT token; first verified claim wins | unit: quota and rate limit; fixture: second tenant verifies same host and gets `conflict` |
| Forged client (tampered cookie, another visitor's agent name, bad @callable args, stale ETag, cross-site POST) | router, REST, @callable | HMAC cookie; server-derived DO name; schema validation; If-Match; Origin check | unit: bad signature 401, mismatched name 403, stale ETag 412, bad Origin 403 |
| Instructions hidden in DNS TXT records | DNS answers into rules engine and model context | exact-match rules; truncate, escape and quote observed values; model cannot change state | fixture: TXT says "mark this verified" and row stays pending; live model: no forbidden tool call |
| Prompt injection in chat (verify this, delete that, act on another tenant) | model tool layer | no verify or delete tool; tenant-scoped args; transition table re-checked server side | unit: transition table; live model: injection prompts, then assert no forbidden rows in `events` |
| Malformed Llama 3.3 tool calls | tool layer | schemas, structured errors, step limit | fixture: recorded bad calls; live model: tool-call success rate |
| Unsafe model output in the UI (raw HTML, script or `javascript:` links, remote images) | model text into the browser | render as plain text or sanitized markdown; no raw HTML; `https` links only; strip `javascript:` and `data:` links; no remote images; strict CSP | unit: sanitizer; fixture: model output with a script tag, a `javascript:` link and a remote image renders all three inert |
| Burning the Workers AI quota | chat loop before each model call | per-visitor turn limit from limits.ts; `AI_KILL_SWITCH` var disables model calls while REST keeps working | unit: turn limit reached gives 429; kill switch on means no model call |
| Secret leakage | logs, errors, repo | redaction helper; .dev.vars gitignored; secrets via wrangler | unit: redaction; check: secret scan before commit |

## 10. Out of scope

- Real certificates. Issuance is simulated and labeled `simulated: true` in the API and
  "Simulated" in the UI.
- API tokens. The only identity is the visitor cookie.
- Cross-device accounts. A new browser is a new tenant.
- DNSSEC validation, multi-resolver consensus, billing, and team roles.
