// Spike D: DNS over HTTPS lookups from inside the Workers runtime.

export type DohAnswer = {
  name: string;
  type: number;
  TTL: number;
  data: string;
};
export type DohResponse = { Status: number; Answer?: DohAnswer[] };

export async function dohLookup(
  name: string,
  type: "TXT" | "CNAME" | "CAA"
): Promise<{ body: DohResponse; ms: number }> {
  const url = new URL("https://cloudflare-dns.com/dns-query");
  url.searchParams.set("name", name);
  url.searchParams.set("type", type);
  const started = Date.now();
  const res = await fetch(url, { headers: { accept: "application/dns-json" } });
  if (!res.ok) throw new Error(`DoH HTTP ${res.status}`);
  const body = (await res.json()) as DohResponse;
  return { body, ms: Date.now() - started };
}

export default {
  fetch() {
    return new Response("spike d");
  }
};
