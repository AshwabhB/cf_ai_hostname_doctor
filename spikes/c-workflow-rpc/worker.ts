// Spike C: a Workflow calls a Durable Object over RPC, sleeps, then calls it again.
import {
  DurableObject,
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep
} from "cloudflare:workers";

export type SpikeParams = { key: string };

export type SpikeEnv = {
  COUNTER: DurableObjectNamespace<Counter>;
  SPIKE_WF: Workflow<SpikeParams>;
};

export class Counter extends DurableObject<SpikeEnv> {
  async bump(): Promise<number> {
    const next = ((await this.ctx.storage.get<number>("n")) ?? 0) + 1;
    await this.ctx.storage.put("n", next);
    return next;
  }

  async read(): Promise<number> {
    return (await this.ctx.storage.get<number>("n")) ?? 0;
  }
}

export class SpikeWorkflow extends WorkflowEntrypoint<SpikeEnv, SpikeParams> {
  async run(event: WorkflowEvent<SpikeParams>, step: WorkflowStep) {
    const counter = () => this.env.COUNTER.getByName(event.payload.key);
    const first = await step.do("bump-1", async () => counter().bump());
    const sleptAt = await step.do("before-sleep", async () => Date.now());
    await step.sleep("nap", "2 seconds");
    const wokeAt = await step.do("after-sleep", async () => Date.now());
    const second = await step.do("bump-2", async () => counter().bump());
    return { first, second, sleptMs: wokeAt - sleptAt };
  }
}

export default {
  fetch() {
    return new Response("spike c");
  }
};
