// A fake cloudflare-dns.com for fixture tests. Nothing here touches the network.
import { DOH_ENDPOINT, DohClient, type DohDeps } from "../src/dns/doh";
import { MemoryDnsCache } from "../src/dns/cache";

export type Behaviour =
  | {
      kind: "answer";
      Status?: number;
      Answer?: Array<{ name: string; type: number; TTL: number; data: string }>;
      soaTtl?: number;
    }
  | { kind: "timeout" }
  | { kind: "network" }
  | { kind: "http"; status: number }
  | { kind: "raw"; body: string };

export const TXT = 16;
export const CNAME = 5;
export const CAA = 257;

export const txt = (name: string, ...values: string[]): Behaviour => ({
  kind: "answer",
  Answer: values.map((v) => ({
    name: `${name}.`,
    type: TXT,
    TTL: 300,
    data: `"${v}"`
  }))
});
export const cname = (name: string, target: string): Behaviour => ({
  kind: "answer",
  Answer: [{ name: `${name}.`, type: CNAME, TTL: 300, data: `${target}.` }]
});
export const caa = (name: string, ...records: string[]): Behaviour => ({
  kind: "answer",
  Answer: records.map((data) => ({
    name: `${name}.`,
    type: CAA,
    TTL: 300,
    data
  }))
});
export const empty: Behaviour = { kind: "answer", Answer: [], soaTtl: 1800 };
export const nxdomain: Behaviour = { kind: "answer", Status: 3, soaTtl: 900 };
export const servfail: Behaviour = { kind: "answer", Status: 2 };

// Behaviours keyed by "TYPE name". A list is consumed one per call, the last one repeats.
export type Zone = Record<string, Behaviour | Behaviour[]>;

export function fakeResolver(zone: Zone) {
  const calls: string[] = [];
  const counts = new Map<string, number>();
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (`${url.origin}${url.pathname}` !== DOH_ENDPOINT) {
      throw new Error(`unexpected outbound fetch to ${url.origin}`);
    }
    const key = `${url.searchParams.get("type")} ${url.searchParams.get("name")}`;
    calls.push(key);
    const n = counts.get(key) ?? 0;
    counts.set(key, n + 1);
    const entry = zone[key] ?? empty;
    const behaviour = Array.isArray(entry)
      ? entry[Math.min(n, entry.length - 1)]
      : entry;
    switch (behaviour.kind) {
      case "timeout":
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError"))
          );
        });
      case "network":
        throw new TypeError("network down");
      case "http":
        return new Response("upstream error", { status: behaviour.status });
      case "raw":
        return new Response(behaviour.body, {
          headers: { "content-type": "application/dns-json" }
        });
      case "answer": {
        const body = {
          Status: behaviour.Status ?? 0,
          Answer: behaviour.Answer,
          Authority: behaviour.soaTtl
            ? [{ name: "zone.", type: 6, TTL: behaviour.soaTtl, data: "soa" }]
            : undefined
        };
        return Response.json(body);
      }
    }
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

export function testClient(zone: Zone, over: Partial<DohDeps> = {}) {
  const resolver = fakeResolver(zone);
  const cache = new MemoryDnsCache();
  const sleeps: number[] = [];
  const clock = { now: Date.UTC(2026, 9, 6) };
  const deps: DohDeps = {
    fetch: resolver.fetch,
    cache,
    now: () => clock.now,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    timeoutMs: 30,
    ...over
  };
  return { client: new DohClient(deps), deps, resolver, cache, sleeps, clock };
}
