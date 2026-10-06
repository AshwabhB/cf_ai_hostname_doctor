import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Opt-in live DNS checks. Never part of `npm test` or CI: they depend on real DNS.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      remoteBindings: false,
      miniflare: {
        bindings: {
          SESSION_SECRET: "test-only-session-secret-not-used-anywhere-else",
          COOKIE_DEV_MODE: "false",
          ALLOWED_ORIGINS: "http://localhost:5173"
        }
      }
    })
  ],
  test: { include: ["test-live/**/*.live.test.ts"], testTimeout: 30_000 }
});
