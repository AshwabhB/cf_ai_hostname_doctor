import { describe, expect, it } from "vitest";
import {
  normalizeHostname,
  type NormalizeError
} from "../src/hostnames/normalize";

const ok: Array<[string, string, string]> = [
  // [input, stored ASCII, displayed Unicode]
  ["shop.example.com", "shop.example.com", "shop.example.com"],
  ["  Shop.Example.COM  ", "shop.example.com", "shop.example.com"],
  ["shop.example.com.", "shop.example.com", "shop.example.com"],
  ["a.co", "a.co", "a.co"],
  ["my-shop.example.co.uk", "my-shop.example.co.uk", "my-shop.example.co.uk"],
  ["xn--bcher-kva.com", "xn--bcher-kva.com", "bücher.com"],
  ["bücher.de", "xn--bcher-kva.de", "bücher.de"],
  ["BÜCHER.de", "xn--bcher-kva.de", "bücher.de"],
  ["münchen.example.com", "xn--mnchen-3ya.example.com", "münchen.example.com"],
  ["例え.jp", "xn--r8jz45g.jp", "例え.jp"],
  ["shop.例え.jp", "shop.xn--r8jz45g.jp", "shop.例え.jp"],
  ["ab--cd.example.com", "ab--cd.example.com", "ab--cd.example.com"],
  ["1shop.example.com", "1shop.example.com", "1shop.example.com"],
  [`${"a".repeat(63)}.com`, `${"a".repeat(63)}.com`, `${"a".repeat(63)}.com`],
  ["foo.workers.dev", "foo.workers.dev", "foo.workers.dev"],
  ["shop.example.com\t", "shop.example.com", "shop.example.com"]
];

const bad: Array<[string, NormalizeError]> = [
  ["", "empty"],
  ["   ", "empty"],
  [".", "empty"],
  [`${"a".repeat(64)}.com`, "label_too_long"],
  [`${Array.from({ length: 60 }, () => "abcd").join(".")}.com`, "too_long"],
  ["x".repeat(2000), "too_long"],
  ["192.168.1.1", "ip_address"],
  ["127.0.0.1.", "ip_address"],
  ["0x7f.1", "ip_address"],
  ["2130706433", "ip_address"],
  ["[::1]", "ip_address"],
  ["2001:db8::1", "ip_address"],
  ["１２７.０.０.１", "ip_address"],
  ["*.example.com", "wildcard"],
  ["shop.*.com", "wildcard"],
  ["localhost", "single_label"],
  ["shop", "single_label"],
  ["app.localhost", "reserved_name"],
  ["shop.test", "reserved_name"],
  ["shop.invalid", "reserved_name"],
  ["shop.example", "reserved_name"],
  ["printer.local", "reserved_name"],
  ["db.internal", "reserved_name"],
  ["co.uk", "public_suffix"],
  ["com", "single_label"],
  ["workers.dev", "public_suffix"],
  ["github.io", "public_suffix"],
  ["shop..example.com", "empty_label"],
  [".example.com", "empty_label"],
  ["-shop.example.com", "hyphen_at_label_edge"],
  ["shop-.example.com", "hyphen_at_label_edge"],
  ["shop_1.example.com", "invalid_characters"],
  ["shop example.com", "invalid_characters"],
  ["shop!.example.com", "invalid_characters"],
  ["https://shop.example.com", "invalid_characters"],
  ["user@shop.example.com", "invalid_characters"],
  ["shop.example.com:443", "invalid_characters"],
  ["shop.example.com?x=1", "invalid_characters"],
  ["shop%2eexample.com", "invalid_characters"],
  ["xn--zz.com", "invalid_characters"],
  ["shop.example.com/path", "invalid_characters"]
];

describe("normalizeHostname accepts", () => {
  it.each(ok)("%j", (input, ascii, unicode) => {
    expect(normalizeHostname(input)).toEqual({ ok: true, ascii, unicode });
  });
});

describe("normalizeHostname rejects", () => {
  it.each(bad)("%j as %s", (input, error) => {
    expect(normalizeHostname(input)).toEqual({ ok: false, error });
  });
});

describe("normalizeHostname output", () => {
  it("is idempotent on its own ASCII output", () => {
    for (const [input] of ok) {
      const first = normalizeHostname(input);
      if (!first.ok) throw new Error(input);
      expect(normalizeHostname(first.ascii)).toEqual(first);
    }
  });

  it("covers at least 25 cases", () => {
    expect(ok.length + bad.length).toBeGreaterThanOrEqual(25);
  });
});
