// Shared test setup.
import { beforeEach, vi } from "vitest";
import { HostnameLifecycle } from "../src/hostnames/lifecycle";

// Unit tests never reach the network. Outbound fetch is replaced once, at load, by a
// guard that refuses every call. Tests that need DNS spy on fetch with the fixture
// resolver, and restoring their mocks returns to this guard, never to the real fetch.
// Workflows started by a test run in the same isolate, so their DoH calls are refused
// too unless a fixture is installed.
export const refusedFetches: string[] = [];

const refuse: typeof fetch = async (input) => {
  refusedFetches.push(input instanceof Request ? input.url : String(input));
  throw new TypeError("outbound network is disabled in unit tests");
};

globalThis.fetch = refuse;

// Creating a hostname starts a verification workflow. Only workflow.test.ts wants a
// real one. Everywhere else the start is stubbed, so no instance is left sleeping when
// a test ends.
beforeEach(() => {
  const real = (globalThis as { __HD_REAL_WORKFLOWS__?: boolean })
    .__HD_REAL_WORKFLOWS__;
  if (!real)
    vi.spyOn(
      HostnameLifecycle.prototype,
      "startVerification"
    ).mockResolvedValue(null);
});
