# Plan

Each stage ends with typecheck, lint and tests passing and a BUILD_LOG.md entry.
Check labels: unit, fixture, live model, deployed.

## S1. Setup and spikes
- Project scaffolded with pinned versions of agents, ai, workers-ai-provider, wrangler,
  vitest with the Workers pool, and a linter. typecheck, lint and test scripts run green.
- src/config/limits.ts exists. .dev.vars is gitignored and a .dev.vars.example is committed.
- Spike A (live model): Llama 3.3 70B fp8-fast through AIChatAgent makes a simple tool call
  over 20 runs. Pass bar: at least 16 of 20 good tool calls. Below that, tool calls move
  to JSON output parsed in code. Success rate recorded either way.
- Spike B (unit): the router can force the TenantAgent name from the server side and reject
  a client-supplied name. Hook names confirmed in the installed agents version.
- Spike C (fixture): a Workflow calls a DO over RPC and survives `step.sleep` in local dev.
- Spike D (fixture): a DoH TXT lookup works from a Worker in local dev.
- `pruneMessages` and resumable streaming confirmed present in the installed versions.

## S2. Visitor isolation
- Signed visitor cookie issued on first visit. Tampered or missing signature gives 401 (unit).
- TenantAgent name comes only from the cookie. Mismatched name gives 403 (unit).
- Two visitors cannot read each other's rows or chat (fixture).

## S3. Data model and REST API
- Tables and indexes from DESIGN.md section 4, created by migration (unit).
- State machine table enforced. Every disallowed pair gives 409 (unit, table driven).
- REST routes from DESIGN.md section 5 with cursor paging, Idempotency-Key, ETag, If-Match,
  and RFC 9457 errors (unit for each status code).
- Every transition writes an `events` row in the same transaction (unit).

## S4. DNS checks
- Hostname normalization and rejection rules (unit).
- Each finding code produced from recorded DoH answers (fixture).
- `isVerified` is the only pass or fail decision (unit).
- A TXT record containing instructions does not change the outcome (fixture).

## S5. Chat agent
- `onChatMessage` uses `streamText`, `pruneMessages`, the tool set and the step limit.
- Tools validate args and only see the current tenant's rows (unit).
- `propose_delete` changes nothing. `confirmDelete` @callable checks ETag and state (unit).
- Model explains a recorded failure using the finding codes (live model).
- Injection prompts produce no forbidden transitions, checked in `events` (live model).

## S6. Workflow and registry
- VerifyWorkflow steps from DESIGN.md section 6. Each step re-run gives the same result (fixture).
- First verified claim wins and the second tenant gets `conflict` (fixture).
- A late step for an old generation writes nothing (fixture).
- Each reconcile case in the table is handled (fixture).
- Delete releases the registry and reaches `deleted` after a forced failure and retry (fixture).

## S7. UI
- Chat pane, hostname list with state badges, DNS instructions with copy buttons,
  findings view, Confirm delete button wired to the @callable.
- Certificates shown as "Simulated". Works at phone width. No em dashes in UI copy.

## S8. Limits and observability
- All limits read from limits.ts. A grep finds no stray numeric limits (unit).
- Per-visitor rate limits and quotas return 429 or `quota-exceeded` (unit).
- Structured logs for transitions, tool calls, workflow steps and model errors, with the
  redaction helper applied. Secret redaction tested (unit).

## S9. Verification
- Full test run, every check labeled, skipped checks listed with reasons.
- Live model run of the tool-call and injection suites, results recorded.
- Threat model table: each test row exists and passes, or is marked as a gap.

## S10. README
- What it does, architecture diagram, local setup, env vars by name only, how to run each
  check label, known limits and the out of scope list.

## S11. Deploy
- Secrets set with wrangler, never echoed. Deployed to workers.dev.
- Smoke checks against the deployed URL: create, verify with a real test domain, chat,
  confirm delete (deployed). Results recorded in BUILD_LOG.md.
