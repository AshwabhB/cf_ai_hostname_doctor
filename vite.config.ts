import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";
import agents from "agents/vite";
import { headersFile } from "./src/config/security-headers";

// Writes the security headers into the client build as _headers. Build only: in dev,
// Vite serves inline scripts that a strict CSP would block.
function securityHeaders(): Plugin {
  return {
    name: "hostname-doctor-security-headers",
    apply: "build",
    generateBundle() {
      if (this.environment?.name !== "client") return;
      this.emitFile({ type: "asset", fileName: "_headers", source: headersFile() });
    }
  };
}

export default defineConfig({
  plugins: [agents(), react(), cloudflare(), tailwindcss(), securityHeaders()]
});
