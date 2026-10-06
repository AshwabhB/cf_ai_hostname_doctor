// The one place a hostname string is turned into the form we store.
// Pure: no I/O, same input always gives the same result.
import { domainToASCII, domainToUnicode } from "node:url";
import { getPublicSuffix } from "tldts";
import { LIMITS } from "../config/limits";

export type NormalizeError =
  | "empty"
  | "too_long"
  | "empty_label"
  | "label_too_long"
  | "invalid_characters"
  | "hyphen_at_label_edge"
  | "single_label"
  | "ip_address"
  | "wildcard"
  | "reserved_name"
  | "public_suffix"
  | "service_hostname"
  | "mixed_script";

export type Normalized =
  | { ok: true; ascii: string; unicode: string }
  | { ok: false; error: NormalizeError };

// Fixed, user-facing explanations. Safe to return to the browser and the model.
export const NORMALIZE_MESSAGES: Record<NormalizeError, string> = {
  empty: "Enter a hostname.",
  too_long: "Hostnames can be at most 253 characters.",
  empty_label:
    "Hostnames cannot contain empty labels such as two dots in a row.",
  label_too_long: "Each part of a hostname can be at most 63 characters.",
  invalid_characters: "Hostnames can contain only letters, digits and hyphens.",
  hyphen_at_label_edge:
    "A part of a hostname cannot start or end with a hyphen.",
  single_label: "Use a full hostname such as shop.example.com.",
  ip_address: "IP addresses cannot be custom hostnames.",
  wildcard: "Wildcard hostnames are not supported.",
  reserved_name:
    "Reserved names such as .test, .local and localhost cannot be used.",
  public_suffix: "A public suffix such as co.uk cannot be used on its own.",
  service_hostname:
    "This hostname belongs to the service itself and cannot be added.",
  mixed_script:
    "Each part of a hostname must use one alphabet. Lookalike letters, such as a Cyrillic а in a Latin name, are refused."
};

export type NormalizeOptions = {
  // The service's own zone (FALLBACK_ORIGIN). It and every name under it are refused.
  serviceZone?: string;
};

const MAX_HOSTNAME = 253;
const MAX_LABEL = 63;
const RESERVED_TLDS = new Set([
  "test",
  "invalid",
  "example",
  "local",
  "internal",
  "localhost"
]);
const LDH_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const LDH_CHARS = /^[a-z0-9-]+$/;

const fail = (error: NormalizeError): Normalized => ({ ok: false, error });

// IPv6 literal, bracketed or not.
const IPV6 = /^\[?[0-9a-f:.]*:[0-9a-f:.]*\]?$/;
// True when an ASCII character other than a letter, digit, dot or hyphen is present.
// Non-ASCII characters are left for IDNA to map or refuse.
function hasStrayAscii(host: string): boolean {
  for (const ch of host) {
    if (ch.charCodeAt(0) < 128 && !/[a-z0-9.-]/.test(ch)) return true;
  }
  return false;
}

// Scripts told apart when checking for lookalikes. A letter in none of them counts as
// "Other", which still cannot be mixed with anything.
const SCRIPTS = [
  "Latin",
  "Cyrillic",
  "Greek",
  "Armenian",
  "Georgian",
  "Hebrew",
  "Arabic",
  "Devanagari",
  "Thai",
  "Han",
  "Hiragana",
  "Katakana",
  "Hangul",
  "Bopomofo"
].map((name) => [name, new RegExp(`^\\p{Script=${name}}$`, "u")] as const);
// Digits, hyphens and combining marks belong to no script of their own.
const NEUTRAL = /^[\p{Script=Common}\p{Script=Inherited}]$/u;
// UTS #39 "highly restrictive": one script per label, or Latin with one of these CJK
// sets, which real Japanese, Chinese and Korean names need.
const ALLOWED_MIXES = [
  ["Latin", "Han", "Hiragana", "Katakana"],
  ["Latin", "Han", "Bopomofo"],
  ["Latin", "Han", "Hangul"]
];

// True when a label mixes scripts in a way that makes lookalikes, such as a Cyrillic
// "а" and "р" inside "раypal".
function mixesScripts(label: string): boolean {
  const scripts = new Set<string>();
  for (const ch of label) {
    if (NEUTRAL.test(ch)) continue;
    scripts.add(SCRIPTS.find(([, re]) => re.test(ch))?.[0] ?? "Other");
  }
  if (scripts.size <= 1) return false;
  return !ALLOWED_MIXES.some((mix) =>
    [...scripts].every((script) => mix.includes(script))
  );
}

// A numeric last label means an IPv4 literal in some form (127.0.0.1, 0x7f.1, 2130706433).
// No real top-level domain is all digits.
function looksLikeIp(host: string): boolean {
  if (IPV6.test(host)) return true;
  const last = host.split(".").at(-1) ?? "";
  return /^(?:0x[0-9a-f]*|[0-9]+)$/.test(last);
}

export function normalizeHostname(
  input: string,
  options: NormalizeOptions = {}
): Normalized {
  if (input.length > LIMITS.hostnames.maxInputChars) return fail("too_long");
  let host = input.trim().toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host === "") return fail("empty");
  if (host.includes("*")) return fail("wildcard");
  if (looksLikeIp(host)) return fail("ip_address");
  if (host.split(".").some((label) => label === "")) return fail("empty_label");
  // domainToASCII parses like a URL host and would silently drop "/path" or "user@".
  if (hasStrayAscii(host)) return fail("invalid_characters");

  // UTS #46 mapping and Punycode, as browsers do. Returns "" when the name is invalid.
  const ascii = domainToASCII(host);
  if (ascii === "") return fail("invalid_characters");
  // Mapping can turn full-width digits into an IPv4 literal, so check again.
  if (looksLikeIp(ascii)) return fail("ip_address");

  if (ascii.length > MAX_HOSTNAME) return fail("too_long");
  const labels = ascii.split(".");
  if (labels.some((label) => label === "")) return fail("empty_label");
  for (const label of labels) {
    if (label.length > MAX_LABEL) return fail("label_too_long");
    if (!LDH_CHARS.test(label)) return fail("invalid_characters");
    if (!LDH_LABEL.test(label)) return fail("hyphen_at_label_edge");
  }
  if (labels.length < 2) return fail("single_label");
  if (RESERVED_TLDS.has(labels.at(-1) ?? "")) return fail("reserved_name");

  // Private suffixes count too, so a bare workers.dev or github.io is refused.
  if (getPublicSuffix(ascii, { allowPrivateDomains: true }) === ascii) {
    return fail("public_suffix");
  }

  const zone = options.serviceZone?.toLowerCase().replace(/\.$/, "");
  if (zone && (ascii === zone || ascii.endsWith(`.${zone}`))) {
    return fail("service_hostname");
  }

  const unicode = domainToUnicode(ascii);
  // Every xn-- label must decode and encode back to itself, so bogus Punycode is refused.
  const unicodeLabels = unicode.split(".");
  const badPunycode = labels.some(
    (label, i) =>
      label.startsWith("xn--") &&
      (unicodeLabels[i] === label ||
        domainToASCII(unicodeLabels[i] ?? "") !== label)
  );
  if (unicode === "" || badPunycode) return fail("invalid_characters");
  // Checked on the decoded form, so Punycode input is caught too.
  if (unicodeLabels.some(mixesScripts)) return fail("mixed_script");

  return { ok: true, ascii, unicode };
}
