# Runbook

How to tell whether Hostname Doctor is healthy, and what to do when it is not. Commands
were checked against wrangler 4.147.

## Where the signals are

- **Logs.** Every log line the app writes is one JSON object with an `event` field.
  `observability` is enabled in `wrangler.jsonc`, so deployed lines land in Workers Logs
  for `hostname-doctor`, where they can be filtered and aggregated by field. For a live
  view: `npx wrangler tail hostname-doctor --format json --search '"event":"model_call"'`.
- **Liveness.** `GET /healthz` returns `{"status":"ok"}`. It needs no session, makes no
  model call and says nothing about the account.
- **Workflows.** `npx wrangler workflows instances list verify-workflow` and
  `npx wrangler workflows instances describe verify-workflow <id>`.

Instance ids contain the visitor's session id. Treat them as private: do not paste them
into tickets or chat. Logs never contain them; a run's `correlation_id` is
`<hostname_id>-g<generation>-r<run>`, which is the instance id without the session id.

## Log events

Every line can carry `visitor` (a keyed hash of the session id, 16 hex characters),
`correlation_id`, `hostname_id`, `outcome` and `latency_ms`. Prompts, model text, cookies,
tokens, TXT values and raw paths are never logged; a redaction helper keeps only
allowlisted keys and masks anything shaped like a secret.

| `event` | Written when | Extra fields | `outcome` values |
|---|---|---|---|
| `api_request` | every `/api/*` call | `method`, `route` (template, e.g. `/api/v1/hostnames/:id`), `status` | `ok`, `client_error`, `server_error` |
| `transition` | a state change commits | `from_state`, `to_state`, `actor`; `latency_ms` is time spent in `from_state` | `committed` |
| `tool_call` | the model runs a tool | `tool` | `ok`, `not_found`, `refused`, `error` |
| `model_call` | a chat turn ends or is refused | `steps`, `first_token_ms` | `ok`, `step_cap`, `invalid_tool_calls`, `first_token_timeout`, `timeout`, `aborted`, `upstream_<status>`, `error`, `quota_exceeded`, `kill_switch` |
| `workflow_step` | a workflow step body runs (replays log nothing) | `step`, `attempt` | `ok`, `fenced`, `not_granted`, `error` |
| `dns_check` | a DNS diagnosis finishes (workflow, manual check, tool) | `lookups`, `findings` (codes only), `attempt` | `verifiable`, `not_verifiable`, `dns_error` |

One REST call, one chat turn or one workflow run shares a `correlation_id` across all of
its lines, including the transitions it causes.

## SLIs

Report each with its sample size n for the window. With a small n (a demo can have single
digits), quote the values themselves rather than a percentile.

### Time to verified

- **What:** how long a hostname waits in `pending` before it is verified.
- **Measured:** `transition` lines with `from_state = pending` and `to_state = verified`.
  `latency_ms` is the time since the hostname was added or last retried. Report p50 and
  p90 of `latency_ms`.
- **n:** the number of those lines.
- **Read with:** the count of `pending` to `failed` transitions in the same window. Those
  never verified (usually the customer's DNS), and are not in the percentile.
- **Note:** this includes the customer's own DNS changes, so it measures the whole
  journey, not only our side. The backoff (30 s, 1 m, 2 m, 5 m, then every 10 m) adds up
  to one interval after the record goes live.

### DoH error rate

- **What:** the share of DNS diagnoses where a DoH lookup failed after its one retry.
- **Measured:** `dns_check` lines. Rate = count with `outcome = dns_error` / count of all.
- **n:** the count of all `dns_check` lines.
- **Note:** a `dns_error` check found at least one `DNS_ERROR` finding. It is per
  diagnosis (up to 12 lookups each), not per lookup.

### API p50

- **What:** median server-side latency of the REST API.
- **Measured:** `api_request` lines, p50 of `latency_ms`, grouped by `route`. Writes
  (`POST /api/v1/hostnames`, `/check`) and reads have different shapes, so compare like
  with like. `/check` includes live DNS.
- **n:** the count of `api_request` lines per route.
- **Note:** measured inside the Worker, so it excludes the client's network time.

### Chat first token

- **What:** time from the start of a model call to its first output (text, reasoning or a
  tool call).
- **Measured:** `model_call` lines with a numeric `first_token_ms`. Report p50 and p90.
- **n:** the count of those lines. Report separately how many `model_call` lines had
  `outcome = first_token_timeout`, since those have no first token.
- **Note:** a call that timed out once and succeeded on its one retry includes the first
  attempt's 10 s in its `first_token_ms`.

## Fixes

### A hostname is stuck in pending

1. Find its lines by `hostname_id`. The newest `dns_check` shows what is blocking it.
   `TXT_MISSING`, `TXT_MISMATCH` or `CNAME_MISSING` mean the customer's DNS is not right
   yet: nothing is stuck, and the records to add are in the hostname drawer.
2. If there is no `dns_check` or `workflow_step` line for that hostname in the last 15
   minutes, its run has stalled. Reconcile handles this on its own: it runs every 10
   minutes while the visitor has rows that need it, and when the visitor's agent starts.
   A pending row with no recorded attempt and no run start for 15 minutes has its run
   terminated and a new one started, whatever status the engine reports.
3. To look at the run: `npx wrangler workflows instances list verify-workflow`, find the
   instance whose id ends in the `correlation_id` from the logs, then `describe` it.
4. To check DNS now without waiting: `POST /api/v1/hostnames/{id}/check` from the
   visitor's session. It runs a fresh diagnosis and never changes state.
5. After 24 hours of attempts the run gives up and the row goes to `failed`. The visitor
   can retry it from chat or `POST /api/v1/hostnames/{id}/retry`, which starts a new run.

### Workers AI quota is out

Two different limits can stop chat.

- **One visitor's daily turns** (`model_call` with `outcome = quota_exceeded`). Each
  visitor gets `LIMITS.chat.turnsPerVisitorPerDay` turns per UTC day. The browser says when
  they reset. Nothing to fix unless the limit is wrong; change it in
  `src/config/limits.ts` and deploy. The hostname table, REST API and workflows keep
  working.
- **The account's Workers AI allocation** (a run of `model_call` lines with
  `outcome = upstream_429` or other `upstream_*` values, across many visitors):
  1. Turn on the kill switch (below), so every visitor gets a clear fixed message instead
     of failed replies.
  2. Check usage for the account in the dashboard under Workers AI.
  3. Wait for the daily reset, or move the account to a plan with more allocation.
  4. Turn the kill switch off and watch `model_call` outcomes return to `ok`.

### Workflow failures

1. Look for `workflow_step` lines with `outcome = error`. The `step` says which:
   - `load`, `record`, `settle`, `activate`, `give-up`: the call back into the visitor's
     agent failed.
   - `claim`, `release-unsettled`: the call to the hostname registry failed.
   - `dns`: the DNS step threw. DoH failures normally come back as a `dns_error` finding,
     not a thrown error.
   The engine retries failed steps on its own.
2. `npx wrangler workflows instances describe verify-workflow <id>` shows retries and the
   error for each step.
3. `fenced` is not a failure. The hostname was deleted or re-added while the run was going,
   so the run stopped without writing.
4. A run that ended `errored` leaves its row pending. Reconcile starts the next run within
   10 minutes (step 2 of the stuck pending fix).
5. Each run is capped at 450 steps in the worst case, under half of the 1,024 allowed per
   instance on the Free plan, so a long run does not hit the step limit.

### The kill switch

`AI_KILL_SWITCH` is a plain variable, `"false"` in `wrangler.jsonc`.

- **Turn on:** set `AI_KILL_SWITCH` to `true` for `hostname-doctor` in the dashboard
  (Settings, Variables and Secrets) and deploy that version, or change it in
  `wrangler.jsonc` and run `npm run deploy`.
- **Effect:** chat answers with a fixed message and makes no model call. These turns do not
  count against a visitor's daily turns. The REST API, the hostname table, deletes and the
  verification workflow keep working.
- **Confirm:** new `model_call` lines show `outcome = kill_switch` and no `first_token_ms`.
- **Turn off:** set it back to `false` the same way. A dashboard change is overwritten by
  the next `npm run deploy` from `wrangler.jsonc`, so keep the two in step.
