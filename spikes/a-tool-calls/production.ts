// Spike A, production mode: the real TenantAgent (prompt, tools, memo, context, retry
// wrapper) driven through saveMessages, with one hostname seeded per trial.
import { getAgentByName } from "agents";
import { TenantAgent } from "../../src/server";

export { HostnameRegistry } from "../../src/server";

export class SpikeTenantAgent extends TenantAgent {
  async onRequest(request: Request): Promise<Response> {
    const { prompt, seed } = (await request.json()) as {
      prompt: string;
      seed: string[];
    };
    for (const hostname of seed) {
      await this.apiCreate({
        hostname,
        idempotencyKey: `seed-${hostname}`,
        requestHash: hostname,
        actor: "user"
      });
    }
    const started = Date.now();
    const result = await this.saveMessages([
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: prompt }]
      }
    ]);
    return Response.json({
      result,
      ms: Date.now() - started,
      messages: this.messages
    });
  }
}

type SpikeEnv = Env & {
  SpikeTenantAgent: DurableObjectNamespace<SpikeTenantAgent>;
};

export default {
  async fetch(request: Request, env: SpikeEnv) {
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    if (url.pathname !== "/trial" || request.method !== "POST" || !id) {
      return new Response("Not found", { status: 404 });
    }
    const agent = await getAgentByName(env.SpikeTenantAgent, id);
    return agent.fetch(request);
  }
};
