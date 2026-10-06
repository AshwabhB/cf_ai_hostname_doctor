// Pure DNS rules (DESIGN.md section 7). Lookup results in, findings out. No I/O.
// Only code here decides whether a hostname is verifiable. The model never does.
import type { DohAnswer, LookupResult } from "./doh";
import { RR_TYPE } from "./doh";
import {
  canonicalName,
  decodeTxtData,
  parseCaaData,
  sanitizeDnsText,
  sanitizeRecords
} from "./text";

export type Severity = "error" | "warning" | "info";

export type FindingCode =
  | "TXT_MISSING"
  | "TXT_MISMATCH"
  | "TXT_MULTIPLE"
  | "CNAME_MISSING"
  | "CNAME_WRONG_TARGET"
  | "APEX_CNAME"
  | "NXDOMAIN"
  | "CAA_BLOCKS"
  | "SERVFAIL"
  | "DNS_TIMEOUT"
  | "DNS_ERROR";

export type Finding = {
  code: FindingCode;
  severity: Severity;
  // The lookup this finding is about, for example "TXT _cf-custom-hostname.shop.example.com".
  record: string;
  expected: string | null;
  // Sanitized DNS text. Data only, never instructions.
  observed: string[];
  observed_truncated: boolean;
  message: string;
};

export type Step = { name: string; result: LookupResult };

export type RuleInput = {
  hostname: string;
  token: string;
  fallbackOrigin: string;
  isApex: boolean;
  txt: Step;
  // CNAME chain lookups, starting at the hostname. Null for an apex hostname.
  cname: Step[] | null;
  // CAA lookups walking up from the hostname, ending at the first non-empty set or failure.
  caa: Step[];
};

// Certificate authorities this service could use. A CAA set must allow one of them.
export const ALLOWED_CAS = ["letsencrypt.org", "pki.goog", "ssl.com"] as const;

const MESSAGES: Record<FindingCode, string> = {
  TXT_MISSING: "The verification TXT record was not found.",
  TXT_MISMATCH:
    "A TXT record exists but none matches this hostname's verification token.",
  TXT_MULTIPLE:
    "The verification TXT record matches, and other TXT records are also present.",
  CNAME_MISSING:
    "There is no CNAME to the fallback origin, so traffic will not reach the service yet.",
  CNAME_WRONG_TARGET: "The CNAME does not point to the fallback origin.",
  APEX_CNAME:
    "This is an apex domain, which cannot hold a CNAME. Use CNAME flattening or an ALIAS record pointing to the fallback origin.",
  NXDOMAIN: "The hostname does not exist in DNS.",
  CAA_BLOCKS:
    "A CAA record stops the certificate authorities this service uses from issuing a certificate.",
  SERVFAIL: "The DNS lookup failed on the resolver (SERVFAIL).",
  DNS_TIMEOUT: "The DNS lookup timed out.",
  DNS_ERROR: "The DNS lookup could not be completed."
};

const SEVERITY_FOR_FAILURE = {
  txt: "error",
  cname: "warning",
  caa: "error"
} as const;

function finding(
  code: FindingCode,
  severity: Severity,
  record: string,
  expected: string | null = null,
  raw: string[] = []
): Finding {
  const { values, truncated } = sanitizeRecords(raw);
  return {
    code,
    severity,
    record,
    expected,
    observed: values,
    observed_truncated: truncated,
    message: MESSAGES[code]
  };
}

function failureCode(result: LookupResult): FindingCode | null {
  switch (result.status) {
    case "servfail":
      return "SERVFAIL";
    case "timeout":
      return "DNS_TIMEOUT";
    case "error":
      return "DNS_ERROR";
    default:
      return null;
  }
}

function answersOfType(result: LookupResult, type: number): DohAnswer[] {
  return result.status === "ok"
    ? result.answers.filter((a) => a.type === type)
    : [];
}

function txtRule(input: RuleInput): Finding[] {
  const record = `TXT ${input.txt.name}`;
  const failure = failureCode(input.txt.result);
  if (failure) return [finding(failure, SEVERITY_FOR_FAILURE.txt, record)];

  const values = answersOfType(input.txt.result, RR_TYPE.TXT).map((a) =>
    decodeTxtData(a.data)
  );
  if (values.length === 0)
    return [finding("TXT_MISSING", "error", record, input.token)];
  // Exact compare on the decoded value. Nothing else in a TXT string is interpreted.
  if (!values.includes(input.token)) {
    return [finding("TXT_MISMATCH", "error", record, input.token, values)];
  }
  return values.length > 1
    ? [finding("TXT_MULTIPLE", "warning", record, input.token, values)]
    : [];
}

function cnameRule(input: RuleInput): Finding[] {
  if (input.isApex || input.cname === null) {
    return [
      finding(
        "APEX_CNAME",
        "info",
        `CNAME ${input.hostname}`,
        input.fallbackOrigin
      )
    ];
  }
  const record = `CNAME ${input.hostname}`;
  const targets: string[] = [];
  for (const [i, step] of input.cname.entries()) {
    const failure = failureCode(step.result);
    if (failure)
      return [
        finding(failure, SEVERITY_FOR_FAILURE.cname, `CNAME ${step.name}`)
      ];
    if (i === 0 && step.result.status === "nxdomain") {
      return [finding("NXDOMAIN", "warning", record)];
    }
    const cname = answersOfType(step.result, RR_TYPE.CNAME).find(
      (a) => canonicalName(a.name) === step.name
    );
    if (!cname) break;
    targets.push(canonicalName(cname.data));
  }
  if (targets.length === 0) {
    return [finding("CNAME_MISSING", "warning", record, input.fallbackOrigin)];
  }
  return targets.includes(input.fallbackOrigin)
    ? []
    : [
        finding(
          "CNAME_WRONG_TARGET",
          "warning",
          record,
          input.fallbackOrigin,
          targets
        )
      ];
}

const KNOWN_CAA_TAGS = new Set(["issue", "issuewild", "iodef"]);

function caaRule(input: RuleInput): Finding[] {
  for (const step of input.caa) {
    const failure = failureCode(step.result);
    if (failure)
      return [finding(failure, SEVERITY_FOR_FAILURE.caa, `CAA ${step.name}`)];
    const answers = answersOfType(step.result, RR_TYPE.CAA);
    if (answers.length === 0) continue;

    // First non-empty set is the relevant one (RFC 8659). Resolvers follow CNAMEs, so the
    // set may belong to an alias target.
    const record = `CAA ${step.name}`;
    const expected = ALLOWED_CAS.join(", ");
    const parsed = answers.map((a) => parseCaaData(a.data));
    const raw = answers.map((a) => a.data);
    // Unreadable or critical unknown tags must stop issuance.
    if (
      parsed.some(
        (r) => r === null || (r.critical && !KNOWN_CAA_TAGS.has(r.tag))
      )
    ) {
      return [finding("CAA_BLOCKS", "error", record, expected, raw)];
    }
    const issue = parsed.filter((r) => r?.tag === "issue");
    if (issue.length === 0) return [];
    const allowed = issue.some((r) =>
      (ALLOWED_CAS as readonly string[]).includes(
        (r?.value.split(";")[0] ?? "").trim().toLowerCase()
      )
    );
    return allowed
      ? []
      : [finding("CAA_BLOCKS", "error", record, expected, raw)];
  }
  return [];
}

export function evaluate(input: RuleInput): Finding[] {
  return [...txtRule(input), ...cnameRule(input), ...caaRule(input)];
}

export function isVerifiable(findings: readonly Finding[]): boolean {
  return !findings.some((f) => f.severity === "error");
}

// Exposed so callers that render a single string use the same sanitizer.
export { sanitizeDnsText };
