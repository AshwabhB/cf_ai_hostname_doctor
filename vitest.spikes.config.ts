import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Spikes B, C and D. Spike A needs the live model and runs with `npm run spike:a`.
const spike = (name: string, dir: string) => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: `./spikes/${dir}/wrangler.jsonc` },
      remoteBindings: false
    })
  ],
  test: { name, include: [`spikes/${dir}/**/*.test.ts`] }
});

export default defineConfig({
  test: {
    projects: [
      spike("spike-b", "b-agent-name"),
      spike("spike-c", "c-workflow-rpc"),
      spike("spike-d", "d-doh")
    ]
  }
});
