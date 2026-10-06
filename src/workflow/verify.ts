// Background DNS verification for one hostname generation (DESIGN.md section 6).
// Every value that changes between runs (token, timestamps, DNS answers) is produced
// inside a step, so a replay sees exactly what the first run saw. Every call back into
// the TenantAgent carries the generation, and a mismatch ends the run without writing.
import {
  AgentWorkflow,
  type AgentWorkflowEvent,
  type AgentWorkflowStep
} from "agents/workflows";
import { MemoryDnsCache } from "../dns/cache";
import { diagnose } from "../dns/diagnose";
import { DohClient, defaultDohDeps } from "../dns/doh";
import {
  dnsCheckFields,
  elapsedMs,
  log,
  visitorHash,
  type LogFields
} from "../observability/log";
import type { TenantAgent } from "../server";
import { sleepAfter } from "./schedule";

export type VerifyParams = {
  tenantId: string;
  hostnameId: string;
  hostname: string;
  generation: number;
  run: number;
};

export type VerifyOutcome = "active" | "conflict" | "failed" | "fenced";

// What a step's result says happened, in one word for the logs.
function stepOutcome(result: unknown): string {
  if (result === null) return "fenced";
  const r = result as Record<string, unknown>;
  if (r.ok === false || r.live === false) return "fenced";
  if (r.granted === false) return "not_granted";
  return "ok";
}

// Wraps a step body so each execution logs one workflow_step line. A replayed step
// returns its saved result without running the body, so it logs nothing.
function logged<T>(
  fields: LogFields,
  step: string,
  body: () => Promise<T>,
  attempt?: number
): () => Promise<T> {
  return async () => {
    const start = Date.now();
    try {
      const result = await body();
      log("workflow_step", {
        ...fields,
        step,
        attempt,
        outcome: stepOutcome(result),
        latency_ms: elapsedMs(start)
      });
      return result;
    } catch (e) {
      log("workflow_step", {
        ...fields,
        step,
        attempt,
        outcome: "error",
        latency_ms: elapsedMs(start)
      });
      throw e;
    }
  };
}

export class VerifyWorkflow extends AgentWorkflow<TenantAgent, VerifyParams> {
  async run(event: AgentWorkflowEvent<VerifyParams>, step: AgentWorkflowStep) {
    const { tenantId, hostnameId, generation, run } = event.payload;
    // The run's log identity. It is derived, not random, so a replay logs the same one.
    // The instance id itself holds the visitor's sid, so it is never logged.
    const correlationId = `${hostnameId}-g${generation}-r${run}`;
    const fields: LogFields = {
      visitor: await visitorHash(this.env.SESSION_SECRET, tenantId),
      correlation_id: correlationId,
      hostname_id: hostnameId
    };

    // Steps persist plain data, so each one copies the fields it needs out of the RPC result.
    const loaded = await step.do(
      "load",
      logged(fields, "load", async () => {
        const row = await this.agent.wfLoad(hostnameId, generation);
        return row ? { hostname: row.hostname, token: row.token } : null;
      })
    );
    if (!loaded) return { outcome: "fenced" as VerifyOutcome };

    let verifiable = false;
    for (let attempt = 0; ; attempt++) {
      // DNS runs here, inside the step. A replay reuses this result instead of asking again.
      const diagnosis = await step.do(
        `dns-${attempt}`,
        logged(
          fields,
          "dns",
          async () => {
            const start = Date.now();
            const client = new DohClient(defaultDohDeps(new MemoryDnsCache()));
            const result = await diagnose(client, {
              hostname: loaded.hostname,
              token: loaded.token,
              fallbackOrigin: this.env.FALLBACK_ORIGIN
            });
            log("dns_check", {
              ...fields,
              ...dnsCheckFields(result),
              attempt,
              latency_ms: elapsedMs(start)
            });
            return { ...result, checkedAt: Date.now() };
          },
          attempt
        )
      );
      const recorded = await step.do(
        `record-${attempt}`,
        logged(
          fields,
          "record",
          async () => {
            const r = await this.agent.wfRecord(
              hostnameId,
              generation,
              diagnosis
            );
            return { live: r.live };
          },
          attempt
        )
      );
      if (!recorded.live) return { outcome: "fenced" as VerifyOutcome };
      if (diagnosis.verifiable) {
        verifiable = true;
        break;
      }
      const sleep = sleepAfter(attempt);
      if (sleep === null) break;
      await step.sleep(`sleep-${attempt}`, `${sleep} seconds`);
    }

    if (!verifiable) {
      await step.do(
        "give-up",
        logged(fields, "give-up", async () => {
          const r = await this.agent.wfGiveUp(
            hostnameId,
            generation,
            correlationId
          );
          return { ok: r.ok };
        })
      );
      return { outcome: "failed" as VerifyOutcome };
    }

    const claim = await step.do(
      "claim",
      logged(fields, "claim", async () => {
        const r = await this.env.HostnameRegistry.getByName(
          loaded.hostname
        ).claim(tenantId, generation);
        return { granted: r.granted };
      })
    );
    const settled = await step.do(
      "settle",
      logged(fields, "settle", async () => {
        const r = await this.agent.wfSettle(
          hostnameId,
          generation,
          claim.granted,
          correlationId
        );
        return { ok: r.ok };
      })
    );
    if (!settled.ok) {
      // The row was deleted or replaced after the claim. Do not leave the claim behind.
      if (claim.granted) {
        await step.do(
          "release-unsettled",
          logged(fields, "release-unsettled", async () => {
            await this.env.HostnameRegistry.getByName(loaded.hostname).release(
              tenantId,
              generation
            );
            return { released: true };
          })
        );
      }
      return { outcome: "fenced" as VerifyOutcome };
    }
    if (!claim.granted) return { outcome: "conflict" as VerifyOutcome };

    // Simulated certificate. The issue time is fixed inside the step.
    const activated = await step.do(
      "activate",
      logged(fields, "activate", async () => {
        const r = await this.agent.wfActivate(
          hostnameId,
          generation,
          Date.now(),
          correlationId
        );
        return { ok: r.ok };
      })
    );
    return { outcome: (activated.ok ? "active" : "fenced") as VerifyOutcome };
  }
}
