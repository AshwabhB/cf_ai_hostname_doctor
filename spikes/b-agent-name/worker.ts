// Spike B: can the router decide the agent name on the server and ignore the client's?
// Two strategies are tried. "rewrite" replaces the name in the URL before routing.
// "guard" uses the onBeforeRequest and onBeforeConnect hooks to reject a mismatch.
import { Agent, routeAgentRequest } from "agents";

// Agent requires its Env to extend the generated Env, so the spike widens it.
export type SpikeEnv = Env & { ProbeAgent: DurableObjectNamespace<ProbeAgent> };

export class ProbeAgent extends Agent<SpikeEnv> {
  onRequest(): Response {
    return new Response(this.name);
  }
}

// Stand-in for the signed visitor cookie. S2 replaces this with HMAC verification.
function visitorFrom(request: Request): string | null {
  return request.headers.get("x-spike-visitor");
}

export function forceAgentName(request: Request, name: string): Request {
  const url = new URL(request.url);
  const parts = url.pathname.split("/");
  // ["", "agents", "<agent>", "<name>", ...rest]
  parts[3] = encodeURIComponent(name);
  url.pathname = parts.join("/");
  return new Request(url, request);
}

export default {
  async fetch(request: Request, env: SpikeEnv) {
    const visitor = visitorFrom(request);
    if (!visitor) return new Response("no visitor", { status: 401 });

    const mode = new URL(request.url).searchParams.get("mode");
    if (mode === "rewrite") {
      return (
        (await routeAgentRequest(forceAgentName(request, visitor), env)) ??
        new Response("Not found", { status: 404 })
      );
    }

    const guard = (_req: Request, route: { name: string }) =>
      route.name === visitor
        ? undefined
        : new Response("agent name mismatch", { status: 403 });

    return (
      (await routeAgentRequest(request, env, {
        onBeforeRequest: guard,
        onBeforeConnect: guard
      })) ?? new Response("Not found", { status: 404 })
    );
  }
};
