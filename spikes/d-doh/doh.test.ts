import { expect, it } from "vitest";
import { dohLookup } from "./worker";

const TXT = 16;
const CNAME = 5;

it("spike D: resolves real TXT records", async () => {
  const { body, ms } = await dohLookup("cloudflare.com", "TXT");
  console.log(
    `spike D: TXT cloudflare.com status=${body.Status} answers=${body.Answer?.length ?? 0} ms=${ms}`
  );
  expect(body.Status).toBe(0);
  expect(body.Answer?.some((a) => a.type === TXT)).toBe(true);
});

it("spike D: resolves a real CNAME", async () => {
  const { body, ms } = await dohLookup("www.github.com", "CNAME");
  console.log(
    `spike D: CNAME www.github.com status=${body.Status} answers=${body.Answer?.length ?? 0} ms=${ms}`
  );
  expect(body.Status).toBe(0);
  expect(body.Answer?.some((a) => a.type === CNAME)).toBe(true);
});

it("spike D: reports NXDOMAIN for a name that cannot exist", async () => {
  const { body, ms } = await dohLookup(
    "_cf-custom-hostname.nothing-here.invalid",
    "TXT"
  );
  console.log(`spike D: TXT under .invalid status=${body.Status} ms=${ms}`);
  expect(body.Status).toBe(3);
});
