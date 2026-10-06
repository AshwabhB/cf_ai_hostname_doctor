// DNS text is attacker controlled. These helpers decode it and make it safe to store
// and show. Nothing here interprets the content.
import { LIMITS } from "../config/limits";

// C0 and C1 controls, DEL, zero-width characters, and bidi embedding, override, isolate
// and mark characters. Written as escapes so no invisible character sits in this file.
/* oxlint-disable no-control-regex -- matching control characters is the purpose */
const UNSAFE =
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2060\ufeff\u180e\u061c\u202a-\u202e\u2066-\u2069]/g;
/* oxlint-enable no-control-regex */

export function sanitizeDnsText(value: string): string {
  return value.replace(UNSAFE, "").slice(0, LIMITS.dns.maxStringChars);
}

// Keeps at most maxRecordsPerName values, each sanitized.
export function sanitizeRecords(values: readonly string[]): {
  values: string[];
  truncated: boolean;
} {
  return {
    values: values.slice(0, LIMITS.dns.maxRecordsPerName).map(sanitizeDnsText),
    truncated: values.length > LIMITS.dns.maxRecordsPerName
  };
}

// Decodes TXT presentation data ("part one" "part two") into one string. Handles \" \\ and
// \DDD escapes. Data without quotes is returned as is.
export function decodeTxtData(data: string): string {
  if (!data.includes('"')) return data;
  let out = "";
  let inQuotes = false;
  for (let i = 0; i < data.length; i++) {
    const ch = data[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes) continue;
    if (ch === "\\" && i + 1 < data.length) {
      const digits = data.slice(i + 1, i + 4);
      if (/^[0-9]{3}$/.test(digits)) {
        out += String.fromCharCode(Number(digits));
        i += 3;
      } else {
        out += data[i + 1];
        i += 1;
      }
      continue;
    }
    out += ch;
  }
  return out;
}

export type CaaRecord = { critical: boolean; tag: string; value: string };

function fromHex(hex: string): Uint8Array | null {
  const clean = hex.replace(/\s+/g, "");
  if (!/^(?:[0-9a-f]{2})*$/i.test(clean)) return null;
  return Uint8Array.from(clean.match(/../g) ?? [], (b) => parseInt(b, 16));
}

// Parses CAA data in presentation form (0 issue "letsencrypt.org") or the RFC 3597
// generic form (\# 22 00 05 69 73 ...). Returns null when it cannot be read.
export function parseCaaData(data: string): CaaRecord | null {
  const text = /^(\d{1,3})\s+([A-Za-z0-9]+)\s+"(.*)"$/.exec(data.trim());
  if (text) {
    return {
      critical: (Number(text[1]) & 128) !== 0,
      tag: text[2].toLowerCase(),
      value: decodeTxtData(`"${text[3]}"`)
    };
  }
  const generic = /^\\#\s+(\d+)\s+([0-9a-fA-F\s]+)$/.exec(data.trim());
  if (!generic) return null;
  const bytes = fromHex(generic[2]);
  if (!bytes || bytes.length !== Number(generic[1]) || bytes.length < 2)
    return null;
  const tagLength = bytes[1];
  if (bytes.length < 2 + tagLength) return null;
  const decoder = new TextDecoder();
  return {
    critical: (bytes[0] & 128) !== 0,
    tag: decoder.decode(bytes.slice(2, 2 + tagLength)).toLowerCase(),
    value: decoder.decode(bytes.slice(2 + tagLength))
  };
}

// Lowercases and strips the trailing dot of a name in an answer.
export function canonicalName(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, "");
}
