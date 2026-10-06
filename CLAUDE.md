# Custom Hostname Agent

An AIChatAgent on Cloudflare Workers that helps SaaS teams add custom hostnames.
Model: Llama 3.3 70B fp8-fast on Workers AI. Spec: docs/DESIGN.md. Stages: docs/PLAN.md.

## APIs
- Check every SDK API (agents, ai, workers-ai-provider, wrangler, Workflows) against the
  installed version in node_modules or its bundled docs. Never write an API from memory.
- If installed types and docs disagree, trust the installed types and note it in the build log.

## Limits
- Every limit, timeout, quota, page size, retry count and TTL lives in src/config/limits.ts.
  No magic numbers anywhere else.

## Trust
- Model output, browser input (REST, WebSocket, @callable args) and DNS data are untrusted.
  Validate all of it with schemas at the boundary.
- The server owns identity and every state change. Visitor identity comes from the signed
  cookie, never from a client-supplied id or agent name.
- Only code in the DNS rules engine decides verification. The model explains findings and
  calls tools. It can never mark a hostname verified or active, and it can never delete.
- Every state change goes through the single transition function in the state machine.

## Secrets
- Never print, log or commit secrets, tokens, cookies or signing keys. Use .dev.vars locally
  (gitignored) and wrangler secrets in production. Redact them in errors and logs.

## Checks
- Label every check as one of: unit, fixture, live model, deployed.
- Only report checks that actually ran, with their result. A skipped check is reported as
  skipped, with the reason.

## Stage discipline
- Work on one stage from docs/PLAN.md at a time. Do only that stage.
- At the end of each stage: run typecheck, lint and tests, append a few lines to
  docs/BUILD_LOG.md (what changed, checks run with labels, open issues), then stop.
- Do not start the next stage until told to.
