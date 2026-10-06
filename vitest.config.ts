import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import agents from "agents/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    agents(),
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Unit tests never reach Cloudflare. Live model checks run separately.
      remoteBindings: false,
      miniflare: {
        // Test-only values. They override .dev.vars so tests never touch the real secret.
        bindings: {
          SESSION_SECRET: "test-only-session-secret-not-used-anywhere-else",
          COOKIE_DEV_MODE: "false"
        }
      }
    })
  ],
  test: {
    include: ["test/**/*.test.ts"]
  }
});
