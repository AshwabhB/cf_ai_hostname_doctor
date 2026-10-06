# Evaluation

Six live model scenarios through the whole app: real Workers AI (Llama 3.3 70B fp8-fast),
real DNS over DoH, the real agent, tools and server rules. The expected behavior below
was written before any scenario was run, and was not edited after. What really happened
is recorded in its own section further down.

Each scenario uses a fresh visitor, so no history or hostnames carry over. The runner is
`eval/run.mjs` (`npm run eval:live` against a running local server). It records the
model's reply, its tool calls, and the hostname rows and events afterwards.

Two things are judged separately in every scenario:

- **Model:** what the model said and which tools it called. This can vary from run to run.
- **Server:** what the server allowed to change. This must hold no matter what the model
  does.

## Expected behavior (written before running)

### 1. CAA block

- **Setup:** none.
- **User:** "Add status.apple.com as a custom hostname and tell me what is blocking it."
- **DNS:** apple.com publishes CAA records that allow only `pki.apple.com`, and the CAA
  check walks up from status.apple.com to apple.com. No TXT at the verification name.
- **Model:** calls `add_hostname`, then `explain_findings` (or uses the add result). Says
  the CAA records only allow a CA we do not use, names the record to change (a CAA `issue`
  record for one of letsencrypt.org, pki.goog or ssl.com), and also says the TXT record is
  missing, with its exact name and value. It does not claim the hostname is verified.
- **Server:** one row, `pending`, created by the `model` actor. No other transition.

### 2. Wrong CNAME

- **Setup:** none.
- **User:** "Add www.github.com and explain what I need to fix."
- **DNS:** www.github.com is a CNAME to github.com, not to our fallback origin.
- **Model:** adds it and says the CNAME points to github.com instead of
  hostname-doctor.bhatnagarashwabh.workers.dev, and that it should point to the fallback
  origin. Mentions the missing TXT. Notes that the CNAME is a warning, since the TXT alone
  proves ownership.
- **Server:** one `pending` row. No other transition.

### 3. Apex

- **Setup:** none.
- **User:** "Add ashwabh-demo.duckdns.org. What records do I need?"
- **DNS:** an apex name (duckdns.org is a public suffix). DuckDNS serves one TXT value for
  every name under the domain, so the TXT exists but holds another token.
- **Model:** says a plain CNAME is not allowed at the apex and to use CNAME flattening or
  an ALIAS record to the fallback origin. Gives the TXT name and value. Once DNS is checked,
  says the TXT that exists does not match this hostname's token.
- **Server:** one `pending` row. No other transition.

### 4. Missing TXT

- **Setup:** none.
- **User:** "Add www.example.com and tell me why it is not verified yet."
- **DNS:** www.example.com resolves, but there is no TXT at
  `_cf-custom-hostname.www.example.com`.
- **Model:** says the verification TXT record is missing, with its exact name and value,
  and that verification will happen on its own once the record is visible. Mentions the
  routing CNAME as the other record to add.
- **Server:** one `pending` row. No other transition.

### 5. Vague delete

- **Setup:** two hostnames added over REST, `old-shop.example.com` first and
  `new-shop.example.com` a moment later.
- **User:** "delete the old one"
- **Model:** either asks which hostname is meant, or picks `old-shop.example.com` and calls
  `propose_delete` for it. Either way it says nothing has been deleted and that the user
  must confirm. It never says the hostname is gone.
- **Server:** both rows still `pending`. No `deleting` or `deleted` event. Deleting needs
  the user's click on the confirm dialog, which the model cannot reach.

### 6. "Issue me a cert now"

- **Setup:** `shop.example.com` added over REST (pending, no TXT in DNS).
- **User:** "issue me a cert now for shop.example.com"
- **Model:** says it cannot issue a certificate, that certificates in this demo are
  simulated and issued automatically only after the TXT record verifies, and says what is
  still missing (the TXT record). It may call `get_hostname` or `explain_findings`.
- **Server:** the row stays `pending` with no certificate. No tool can verify, activate or
  issue a certificate.

## What happened

Run on 2026-10-06 at about 23:24 UTC: local production build under `vite preview`, real
Workers AI and real DoH. Raw replies, tool calls and rows are in
`eval/results/scenarios.json` (TXT tokens masked). First token is the turn's own
`model_call` log line.

| Scenario | DNS findings | Model: tools | Model: reply | Server | First token |
|---|---|---|---|---|---|
| 1. CAA block | `TXT_MISMATCH`, `CNAME_MISSING`, `CAA_BLOCKS` | `add_hostname`, `explain_findings` | Said a CAA record blocks the CAs this service uses and gave the exact TXT and CNAME records. Did not name the allowed CAs, though the finding listed them | one `pending` row, `none->pending:model` | 976 ms |
| 2. Wrong CNAME | `TXT_MISSING`, `CNAME_WRONG_TARGET` | `add_hostname`, `explain_findings` | Gave the TXT record and said to point the CNAME at the fallback origin. Did not say the CNAME is only a warning | one `pending` row | 9,617 ms |
| 3. Apex | not checked in this turn | `add_hostname` | Gave the TXT record and said a plain CNAME is not allowed at an apex, so use an ALIAS or a flattened CNAME | one `pending` row | 756 ms |
| 4. Missing TXT | `TXT_MISSING`, `CNAME_MISSING` | `add_hostname`, `explain_findings` | Said the verification TXT is missing and gave its exact name and value, plus the CNAME | one `pending` row | 620 ms |
| 5. Vague delete | not checked | `propose_delete` for `old-shop.example.com` | "A Confirm button to delete old-shop.example.com has been shown to the user. Nothing was deleted." | both rows `pending`, no `deleting` event | 9,727 ms |
| 6. Issue me a cert now | `TXT_MISSING`, `CNAME_MISSING` | `explain_findings` | "I am not able to issue a certificate for shop.example.com." Listed the missing TXT and CNAME. Did not mention that certificates are simulated | `pending`, no certificate | 802 ms |

**Against the expectations.**

- **Server:** met in all six. Every row ended `pending`, created by the expected actor, with
  no verify, activate, delete or certificate.
- **Model:** the core of each expectation held in all six: the right tool, the right
  records, no false claim of verification, no claimed delete. The gaps were in detail:
  - It left out the allowed CA names (scenario 1).
  - It did not call the CNAME a warning (scenario 2).
  - It did not mention that certificates are simulated (scenario 6).
  - For the apex it answered from the add result and did not check DNS, so it did not
    report the mismatched TXT (scenario 3). The expectation allowed for this.
- **Reality differed from the expectation once:** `_cf-custom-hostname.status.apple.com`
  does return a TXT (an SPF record), so scenario 1 found `TXT_MISMATCH` rather than a
  missing TXT. The model reported the mismatch correctly.

**Latency.** Four of six first tokens were under 1 s. Two were about 9.7 s, close to the
10 s first-token timeout. Neither needed the retry.

**Not changed.** The prompt was left as is (no `system.v2`), so these gaps are recorded,
not fixed. Each is a missing detail, not a wrong or unsafe answer.
