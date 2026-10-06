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

export class VerifyWorkflow extends AgentWorkflow<TenantAgent, VerifyParams> {
  async run(event: AgentWorkflowEvent<VerifyParams>, step: AgentWorkflowStep) {
    const { tenantId, hostnameId, generation } = event.payload;

    // Steps persist plain data, so each one copies the fields it needs out of the RPC result.
    const loaded = await step.do("load", async () => {
      const row = await this.agent.wfLoad(hostnameId, generation);
      return row ? { hostname: row.hostname, token: row.token } : null;
    });
    if (!loaded) return { outcome: "fenced" as VerifyOutcome };

    let verifiable = false;
    for (let attempt = 0; ; attempt++) {
      // DNS runs here, inside the step. A replay reuses this result instead of asking again.
      const diagnosis = await step.do(`dns-${attempt}`, async () => {
        const client = new DohClient(defaultDohDeps(new MemoryDnsCache()));
        const result = await diagnose(client, {
          hostname: loaded.hostname,
          token: loaded.token,
          fallbackOrigin: this.env.FALLBACK_ORIGIN
        });
        return { ...result, checkedAt: Date.now() };
      });
      const recorded = await step.do(`record-${attempt}`, async () => {
        const r = await this.agent.wfRecord(hostnameId, generation, diagnosis);
        return { live: r.live };
      });
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
      await step.do("give-up", async () => {
        const r = await this.agent.wfGiveUp(hostnameId, generation);
        return { ok: r.ok };
      });
      return { outcome: "failed" as VerifyOutcome };
    }

    const claim = await step.do("claim", async () => {
      const r = await this.env.HostnameRegistry.getByName(
        loaded.hostname
      ).claim(tenantId, generation);
      return { granted: r.granted };
    });
    const settled = await step.do("settle", async () => {
      const r = await this.agent.wfSettle(
        hostnameId,
        generation,
        claim.granted
      );
      return { ok: r.ok };
    });
    if (!settled.ok) {
      // The row was deleted or replaced after the claim. Do not leave the claim behind.
      if (claim.granted) {
        await step.do("release-unsettled", async () => {
          await this.env.HostnameRegistry.getByName(loaded.hostname).release(
            tenantId,
            generation
          );
          return { released: true };
        });
      }
      return { outcome: "fenced" as VerifyOutcome };
    }
    if (!claim.granted) return { outcome: "conflict" as VerifyOutcome };

    // Simulated certificate. The issue time is fixed inside the step.
    const activated = await step.do("activate", async () => {
      const r = await this.agent.wfActivate(hostnameId, generation, Date.now());
      return { ok: r.ok };
    });
    return { outcome: (activated.ok ? "active" : "fenced") as VerifyOutcome };
  }
}
