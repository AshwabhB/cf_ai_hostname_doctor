import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import agents from "agents/vite";
import { defineConfig } from "vitest/config";

// Opt-in live DNS checks. Never part of `npm test` or CI: they depend on real DNS.
export default defineConfig({
  plugins: [
    // Compiles the @callable decorators in src/server.ts, as in vitest.config.ts.
    agents(),
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      remoteBindings: false,
      miniflare: {
        bindings: {
          SESSION_SECRET: "test-only-session-secret-not-used-anywhere-else",
          COOKIE_DEV_MODE: "false",
          ALLOWED_ORIGINS: "http://localhost:5173",
          // The TXT value currently on the DuckDNS demo domain. Read from the shell so a
          // stale value never sits in the repo. Unset means the DuckDNS case is skipped.
          ...(process.env.LIVE_DUCKDNS_TXT
            ? { LIVE_DUCKDNS_TXT: process.env.LIVE_DUCKDNS_TXT }
            : {})
        }
      }
    })
  ],
  test: { include: ["test-live/**/*.live.test.ts"], testTimeout: 30_000 }
});
