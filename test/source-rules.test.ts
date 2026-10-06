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
