// Response headers for the production app. One source for both the static assets
// (written into the build's _headers file by vite.config.ts) and the Worker's own
// responses. Dev mode skips the asset copy because Vite injects inline scripts there.

export const PRODUCTION_ORIGIN = "https://hostname-doctor.bhatnagarashwabh.workers.dev";

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  // 'self' covers same-origin ws: and wss:. The production socket is listed as well,
  // as asked, so it holds even where a browser reads 'self' narrowly.
  `connect-src 'self' ${PRODUCTION_ORIGIN.replace("https://", "wss://")}`,
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join("; ");

export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer"
};

// The _headers file format for Workers static assets.
export function headersFile(): string {
  return [
    "/*",
    ...Object.entries(SECURITY_HEADERS).map(([k, v]) => `  ${k}: ${v}`),
    ""
  ].join("\n");
}
