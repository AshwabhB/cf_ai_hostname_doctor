// DESIGN.md section 2. Every pair not listed here is rejected.

export const STATES = [
  "pending",
  "verified",
  "active",
  "failed",
  "conflict",
  "deleting",
  "deleted"
] as const;
export type HostnameState = (typeof STATES)[number];

export const ACTORS = ["user", "model", "system"] as const;
export type Actor = (typeof ACTORS)[number];

type Rule = {
  from: HostnameState;
  to: HostnameState;
  actors: readonly Actor[];
};

const RULES: readonly Rule[] = [
  { from: "pending", to: "verified", actors: ["system"] },
  { from: "pending", to: "conflict", actors: ["system"] },
  { from: "pending", to: "failed", actors: ["system"] },
  { from: "verified", to: "active", actors: ["system"] },
  { from: "failed", to: "pending", actors: ["user", "model"] },
  { from: "conflict", to: "pending", actors: ["user", "model"] },
  { from: "verified", to: "conflict", actors: ["system"] },
  { from: "active", to: "conflict", actors: ["system"] },
  { from: "pending", to: "deleting", actors: ["user"] },
  { from: "verified", to: "deleting", actors: ["user"] },
  { from: "active", to: "deleting", actors: ["user"] },
  { from: "failed", to: "deleting", actors: ["user"] },
  { from: "conflict", to: "deleting", actors: ["user"] },
  { from: "deleting", to: "deleted", actors: ["system"] }
];

// Creating a row (no previous state) is allowed for these actors.
export const CREATE_ACTORS: readonly Actor[] = ["user", "model"];

export function isAllowed(
  from: HostnameState,
  to: HostnameState,
  actor: Actor
): boolean {
  return RULES.some(
    (r) => r.from === from && r.to === to && r.actors.includes(actor)
  );
}

export function allowedTransitions(): ReadonlyArray<Readonly<Rule>> {
  return RULES;
}
