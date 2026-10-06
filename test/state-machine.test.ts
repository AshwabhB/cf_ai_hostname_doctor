import { describe, expect, it } from "vitest";
import {
  ACTORS,
  CREATE_ACTORS,
  STATES,
  isAllowed,
  type Actor,
  type HostnameState
} from "../src/hostnames/state-machine";

// Copied by hand from DESIGN.md section 2, so the code table is checked against the spec.
const SPEC: Array<[HostnameState, HostnameState, Actor[]]> = [
  ["pending", "verified", ["system"]],
  ["pending", "conflict", ["system"]],
  ["pending", "failed", ["system"]],
  ["verified", "active", ["system"]],
  ["failed", "pending", ["user", "model"]],
  ["conflict", "pending", ["user", "model"]],
  ["verified", "conflict", ["system"]],
  ["active", "conflict", ["system"]],
  ["pending", "deleting", ["user"]],
  ["verified", "deleting", ["user"]],
  ["active", "deleting", ["user"]],
  ["failed", "deleting", ["user"]],
  ["conflict", "deleting", ["user"]],
  ["deleting", "deleted", ["system"]]
];

const expected = (from: HostnameState, to: HostnameState, actor: Actor) =>
  SPEC.some(
    ([f, t, actors]) => f === from && t === to && actors.includes(actor)
  );

const cases = STATES.flatMap((from) =>
  STATES.flatMap((to) => ACTORS.map((actor) => [from, to, actor] as const))
);

describe("transition table", () => {
  it.each(cases)("%s -> %s by %s", (from, to, actor) => {
    expect(isAllowed(from, to, actor)).toBe(expected(from, to, actor));
  });

  it("checks all 147 from, to and actor combinations", () => {
    expect(cases).toHaveLength(147);
    expect(cases.filter(([f, t, a]) => expected(f, t, a))).toHaveLength(16);
  });

  it("never lets the model verify, activate or delete", () => {
    for (const to of ["verified", "active", "deleting", "deleted"] as const) {
      for (const from of STATES)
        expect(isAllowed(from, to, "model")).toBe(false);
    }
  });

  it("lets only users and the model create", () => {
    expect([...CREATE_ACTORS].sort()).toEqual(["model", "user"]);
  });
});
