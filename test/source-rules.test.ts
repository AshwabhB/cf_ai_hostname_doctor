// Rules about the source tree itself.
import { describe, expect, it } from "vitest";

const sources = import.meta.glob(["../src/**/*.{ts,tsx}"], {
  query: "?raw",
  import: "default",
  eager: true
}) as Record<string, string>;

const allFiles = import.meta.glob(
  ["../src/**/*.{ts,tsx}", "../test/**/*.ts", "../spikes/**/*.{ts,mjs}"],
  { query: "?raw", import: "default", eager: true }
) as Record<string, string>;

// Browser files run in the visitor's tab and only call our own origin.
const isBrowserFile = (file: string) =>
  file === "../src/app.tsx" ||
  file === "../src/client.tsx" ||
  file.startsWith("../src/ui/");
const DOH_FILE = "../src/dns/doh.ts";

// Built from code points so this file never holds the characters it looks for.
const INVISIBLE_RANGES: Array<[number, number]> = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x9f],
  [0x061c, 0x061c],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2060],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff]
];

function firstInvisible(text: string): number | null {
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (INVISIBLE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi)) return cp;
  }
  return null;
}

describe("source rules", () => {
  it("found the server sources", () => {
    expect(Object.keys(sources)).toContain(DOH_FILE);
    expect(Object.keys(sources).length).toBeGreaterThan(10);
  });

  it("makes outbound fetches only from the DoH client", () => {
    const offenders = Object.entries(sources)
      .filter(([file]) => file !== DOH_FILE && !isBrowserFile(file))
      .filter(([, text]) => /\bfetch\s*\(/.test(text))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  it("never injects HTML or loads remote URLs from browser code", () => {
    const browser = Object.entries(sources).filter(([file]) =>
      isBrowserFile(file)
    );
    expect(browser.length).toBeGreaterThan(3);
    const offenders = browser
      .filter(([, text]) =>
        /dangerouslySetInnerHTML|\.innerHTML\s*=|\beval\s*\(|new Function\s*\(/.test(
          text
        )
      )
      .map(([file]) => file);
    expect(offenders).toEqual([]);
    // Browser fetches take a same-origin path, never a full URL.
    const remote = browser
      .filter(([, text]) => /\bfetch\s*\(\s*["'`]https?:/.test(text))
      .map(([file]) => file);
    expect(remote).toEqual([]);
  });

  it("names only cloudflare-dns.com as a remote endpoint in the DoH client", () => {
    const urls = sources[DOH_FILE].match(/https?:\/\/[^\s"'`]+/g) ?? [];
    expect([...new Set(urls)]).toEqual([
      "https://cloudflare-dns.com/dns-query"
    ]);
  });

  it("contains no invisible or bidi control characters", () => {
    const offenders = Object.entries(allFiles)
      .map(([file, text]) => [file, firstInvisible(text)] as const)
      .filter(([, cp]) => cp !== null)
      .map(([file, cp]) => `${file} U+${cp?.toString(16)}`);
    expect(offenders).toEqual([]);
  });
});

// ---- Numeric limits live in src/config/limits.ts ----

const LIMITS_FILE = "../src/config/limits.ts";

// Values that are protocol or unit facts, not tunable limits, allowed in any file.
const PROTOCOL_NUMBERS = new Set([
  // HTTP status codes
  101, 200, 201, 202, 204, 304, 400, 401, 403, 404, 405, 409, 412, 413, 422,
  428, 429, 500,
  // WebSocket close codes: RFC 6455 and our own in src/config/protocol.ts
  1003, 1009, 4401, 4429,
  // time unit factors: hours per day, minutes, seconds, ms per second, s per hour
  24,
  60, 1000, 3600
]);

// Wire formats and fixed structure, per file, with the reason each is not a limit.
const FILE_NUMBERS: Record<string, { numbers: number[]; why: string }> = {
  "../src/dns/doh.ts": {
    numbers: [3, 5, 16, 253, 257],
    why: "DNS record types (CNAME, TXT, CAA), the NXDOMAIN rcode, RFC 1035 name length"
  },
  "../src/dns/text.ts": {
    numbers: [2, 3, 4, 16, 128],
    why: "TXT \\DDD escapes, hex radix, CAA critical flag bit and header offsets"
  },
  "../src/hostnames/normalize.ts": {
    numbers: [2, 63, 128, 253],
    why: "RFC 1035 label and name lengths, the ASCII range, two labels minimum"
  },
  "../src/security/session.ts": {
    numbers: [2, 4, 16],
    why: "payload.signature parts, base64 padding, hex radix"
  },
  "../src/api/hostnames.ts": {
    numbers: [2, 4, 16],
    why: "path segments before the id, hex formatting"
  },
  "../src/hostnames/service.ts": {
    numbers: [2, 16],
    why: "a regex capture group index, hex formatting"
  },
  "../src/observability/log.ts": { numbers: [2, 16], why: "hex formatting" },
  "../src/workflow/schedule.ts": {
    numbers: [2, 4],
    why: "steps per DNS attempt and the fixed steps in verify.ts"
  }
};

function skipQuoted(text: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < text.length && text[i] !== quote) i += text[i] === "\\" ? 2 : 1;
  return i + 1;
}

function skipRegex(text: string, start: number): number {
  let i = start + 1;
  let inClass = false;
  while (i < text.length && text[i] !== "\n") {
    const c = text[i];
    if (c === "\\") i += 2;
    else {
      if (c === "[") inClass = true;
      else if (c === "]") inClass = false;
      else if (c === "/" && !inClass) break;
      i++;
    }
  }
  i++;
  while (i < text.length && /[a-z]/.test(text[i])) i++;
  return i;
}

// Code with comments, strings, templates and regex literals blanked out, line breaks
// kept so line numbers still match. Numbers inside template expressions are skipped.
function codeOnly(text: string): string {
  let out = "";
  let prev = "";
  let i = 0;
  const keepLines = (from: number, to: number) =>
    text.slice(from, to).replace(/[^\n]/g, " ");
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    let end = -1;
    let regex = false;
    if (c === "/" && next === "/") {
      end = text.indexOf("\n", i);
      if (end < 0) end = text.length;
    } else if (c === "/" && next === "*") {
      const close = text.indexOf("*/", i + 2);
      end = close < 0 ? text.length : close + 2;
    } else if (c === '"' || c === "'" || c === "`") {
      end = skipQuoted(text, i, c);
    } else if (
      c === "/" &&
      (prev === "" ||
        "(,=:[!&|?{};>".includes(prev) ||
        /\breturn\s*$/.test(out))
    ) {
      end = skipRegex(text, i);
      regex = true;
    }
    if (end >= 0) {
      out += keepLines(i, end);
      prev = regex || c !== "/" ? "x" : prev;
      i = end;
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  // Icon sizes in JSX are pixels, not limits.
  return out.replace(/\bsize=\{\d+\}/g, "size={}");
}

function numbersIn(text: string): Array<{ line: number; value: number }> {
  const found: Array<{ line: number; value: number }> = [];
  codeOnly(text)
    .split("\n")
    .forEach((line, index) => {
      for (const m of line.matchAll(
        /(?<![\w.$])(0x[0-9a-f]+|\d[\d_]*(?:\.\d+)?)(?![\w])/gi
      )) {
        const value = Number(m[1].replaceAll("_", ""));
        if (value !== 0 && value !== 1) found.push({ line: index + 1, value });
      }
    });
  return found;
}

describe("limits", () => {
  it("the scan finds a planted limit and ignores comments, strings and regexes", () => {
    expect(numbersIn("const timeoutMs = 2_500;").map((n) => n.value)).toEqual([
      2500
    ]);
    expect(
      numbersIn(
        [
          "// wait 30 s",
          "const a = 'v2 of 9';",
          "const b = `${'x'} 42`;",
          "const re = /^[0-9]{1,3}$/;",
          "return /x{7}/.test(s);"
        ].join("\n")
      )
    ).toEqual([]);
  });

  it("keeps every numeric limit in limits.ts", () => {
    const offenders: string[] = [];
    for (const [file, text] of Object.entries(sources)) {
      if (file === LIMITS_FILE) continue;
      const allowed = new Set(FILE_NUMBERS[file]?.numbers ?? []);
      for (const { line, value } of numbersIn(text)) {
        if (PROTOCOL_NUMBERS.has(value) || allowed.has(value)) continue;
        offenders.push(`${file.slice(3)}:${line} ${value}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("lists only allowances that are still needed", () => {
    const unused: string[] = [];
    for (const [file, { numbers }] of Object.entries(FILE_NUMBERS)) {
      const present = new Set(
        numbersIn(sources[file] ?? "").map((n) => n.value)
      );
      for (const n of numbers) if (!present.has(n)) unused.push(`${file} ${n}`);
    }
    expect(unused).toEqual([]);
  });
});
