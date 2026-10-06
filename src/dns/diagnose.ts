// Runs the lookups for one hostname and hands the results to the pure rules.
// Every name queried comes from the normalized hostname, its parents, or a CNAME target
// that itself passes normalization.
import { getDomain } from "tldts";
import { LIMITS } from "../config/limits";
import { normalizeHostname } from "../hostnames/normalize";
import { RR_TYPE, type DohClient } from "./doh";
import { evaluate, isVerifiable, type Finding, type Step } from "./rules";
import { canonicalName } from "./text";
import { TXT_PREFIX } from "../hostnames/service";

export type Diagnosis = {
  verifiable: boolean;
  findings: Finding[];
  lookups: number;
};

export async function diagnose(
  client: DohClient,
  input: { hostname: string; token: string; fallbackOrigin: string }
): Promise<Diagnosis> {
  const normalized = normalizeHostname(input.hostname);
  const fallback = canonicalName(input.fallbackOrigin);
  if (!normalized.ok) {
    const findings: Finding[] = [
      {
        code: "DNS_ERROR",
        severity: "error",
        record: "hostname",
        expected: null,
        observed: [],
        observed_truncated: false,
        message: "The hostname could not be checked."
      }
    ];
    return { verifiable: false, findings, lookups: 0 };
  }
  const host = normalized.ascii;
  const isApex = getDomain(host, { allowPrivateDomains: true }) === host;

  const txtName = `${TXT_PREFIX}.${host}`;
  const txt: Step = {
    name: txtName,
    result: await client.lookup(txtName, "TXT")
  };

  let cname: Step[] | null = null;
  if (!isApex) {
    cname = [];
    let current = host;
    for (let hop = 0; hop <= LIMITS.dns.cnameMaxHops; hop++) {
      const result = await client.lookup(current, "CNAME");
      cname.push({ name: current, result });
      if (result.status !== "ok") break;
      const answer = result.answers.find(
        (a) => a.type === RR_TYPE.CNAME && canonicalName(a.name) === current
      );
      if (!answer) break;
      const target = canonicalName(answer.data);
      if (target === fallback || hop === LIMITS.dns.cnameMaxHops) break;
      // The target came from DNS, so it must pass normalization before we query it.
      const next = normalizeHostname(target);
      if (!next.ok) break;
      current = next.ascii;
    }
  }

  const caa: Step[] = [];
  const labels = host.split(".");
  for (let i = 0; i < labels.length; i++) {
    const name = labels.slice(i).join(".");
    const result = await client.lookup(name, "CAA");
    caa.push({ name, result });
    const hasSet =
      result.status === "ok" &&
      result.answers.some((a) => a.type === RR_TYPE.CAA);
    if (result.status !== "ok" && result.status !== "nxdomain") break;
    if (hasSet) break;
  }

  const findings = evaluate({
    hostname: host,
    token: input.token,
    fallbackOrigin: fallback,
    isApex,
    txt,
    cname,
    caa
  });
  return {
    verifiable: isVerifiable(findings),
    findings,
    lookups: client.lookupsUsed
  };
}
