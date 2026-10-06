import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import type { SpikeEnv } from "./worker";

const spikeEnv = env as unknown as SpikeEnv;

async function waitForTerminal(instance: WorkflowInstance, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await instance.status();
    if (["complete", "errored", "terminated"].includes(status.status)) {
      return status;
    }
    if (Date.now() > deadline) return status;
    await new Promise((r) => setTimeout(r, 250));
  }
}

it("spike C: workflow calls a DO over RPC across a step.sleep", async () => {
  const startedAt = Date.now();
  const instance = await spikeEnv.SPIKE_WF.create({
    id: "spike-c-1",
    params: { key: "k1" }
  });

  const status = await waitForTerminal(instance, 30_000);
  const elapsedMs = Date.now() - startedAt;
  console.log(
    `spike C: status=${status.status} elapsedMs=${elapsedMs}`,
    status.output
  );

  expect(status.status).toBe("complete");
  const output = status.output as {
    first: number;
    second: number;
    sleptMs: number;
  };
  expect(output.first).toBe(1);
  expect(output.second).toBe(2);
  expect(output.sleptMs).toBeGreaterThanOrEqual(2000);

  // Each RPC step ran exactly once, so the DO saw two bumps in total.
  expect(await spikeEnv.COUNTER.getByName("k1").read()).toBe(2);
}, 40_000);
