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
          COOKIE_DEV_MODE: "false",
          // Production allows only workers.dev. Tests use the local dev origin.
          ALLOWED_ORIGINS: "http://localhost:5173"
        }
      }
    })
  ],
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
    // The app's structured log lines are checked in test/logs.test.ts. Everywhere else
    // they would only fill the output, so they are dropped. Other output still shows.
    onConsoleLog: (line) =>
      line.startsWith('{"') && line.includes('"event":') ? false : undefined
  }
});
