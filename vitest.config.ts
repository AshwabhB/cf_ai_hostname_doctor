import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import agents from "agents/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    agents(),
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Unit tests never reach Cloudflare. Live model checks run separately.
      remoteBindings: false
    })
  ],
  test: {
    include: ["test/**/*.test.ts"]
  }
});
