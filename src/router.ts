// Worker entry routing. Identity always comes from the signed cookie. The browser
// asks for the agent named "me", and the router rewrites that to the visitor's sid.
import { routeAgentRequest } from "agents";
import { HOSTNAMES_PATH, handleHostnames } from "./api/hostnames";
import { LIMITS } from "./config/limits";
import { SECURITY_HEADERS } from "./config/security-headers";
import { AGENT_ALIAS, HEALTH_PATH, SESSION_PATH } from "./config/protocol";
import {
  annotateLogContext,
  elapsedMs,
  log,
  visitorHash,
  withLogContext
} from "./observability/log";
import {
  NO_STORE,
  isAllowedOrigin,
  isWebSocketUpgrade,
  problem
} from "./security/http";
import {
  encodeSession,
  needsRenewal,
  newSession,
  readSession,
  renewed,
  setCookieHeader,
  type SessionPayload
} from "./security/session";

const AGENT_CLASS = "tenant-agent";
// Query parameter the router sets on the rewritten upgrade URL. TenantAgent reads
// it from connection.uri, which survives hibernation, to close expired sockets.
export const SESSION_EXP_PARAM = "__hd_exp";

const nowSeconds = () => Math.floor(Date.now() / 1000);

// Every Worker response carries the security headers. A 101 WebSocket upgrade is
// passed through untouched.
function withSecurityHeaders(res: Response): Response {
  if (res.status === 101 || res.webSocket) return res;
  const headers = new Headers(res.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS))
    headers.set(name, value);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers
  });
}

export async function handleRequest(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) {
    return withSecurityHeaders(await route(request, env));
  }
  // One api_request line per REST call. The id also reaches the agent, so the
  // transitions a request causes carry the same correlation id.
  const start = Date.now();
  const res = await withLogContext(
    { correlation_id: crypto.randomUUID() },
    async () => {
      const response = await route(request, env);
      log("api_request", {
        method: request.method,
        route: routeTemplate(url.pathname),
        status: response.status,
        outcome:
          response.status < 400
            ? "ok"
            : response.status < 500
              ? "client_error"
              : "server_error",
        latency_ms: elapsedMs(start)
      });
      return response;
    }
  );
  return withSecurityHeaders(res);
}

const HOSTNAME_SUBROUTES = new Set(["events", "check", "diagnosis", "retry"]);

// The path with ids replaced, so logs never hold raw paths a client chose.
export function routeTemplate(pathname: string): string {
  if (pathname === SESSION_PATH) return SESSION_PATH;
  const [, api, version, collection, id, sub, ...extra] = pathname.split("/");
  if (api !== "api" || version !== "v1" || collection !== "hostnames") {
    return "other";
  }
  if (!id) return "/api/v1/hostnames";
  if (sub === undefined) return "/api/v1/hostnames/:id";
  if (extra.length === 0 && HOSTNAME_SUBROUTES.has(sub)) {
    return `/api/v1/hostnames/:id/${sub}`;
  }
  return "other";
}

// Liveness only. No session, no model call, nothing about the account.
function handleHealth(request: Request): Response {
  if (request.method !== "GET") return problem("method-not-allowed", request);
  return new Response(JSON.stringify({ status: "ok" }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": NO_STORE }
  });
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === HEALTH_PATH) return handleHealth(request);

  // No CORS anywhere, so preflights are refused outright.
  if (request.method === "OPTIONS") {
    return problem(
      "forbidden",
      request,
      "Cross-origin requests are not allowed."
    );
  }
  const needsOrigin = request.method !== "GET" || isWebSocketUpgrade(request);
  if (needsOrigin && !isAllowedOrigin(request, env)) {
    return problem("forbidden", request, "Origin not allowed.");
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > LIMITS.http.maxBodyBytes) {
    return problem("payload-too-large", request);
  }

  if (url.pathname === SESSION_PATH) return handleSession(request, env);
  if (
    url.pathname === HOSTNAMES_PATH ||
    url.pathname.startsWith(`${HOSTNAMES_PATH}/`)
  ) {
    const session = await readSession(request, env, nowSeconds());
    if (!session.ok) return problem("unauthorized", request);
    annotateLogContext({
      visitor: await visitorHash(env.SESSION_SECRET, session.payload.sid)
    });
    return handleHostnames(request, env, url, session.payload.sid);
  }
  if (url.pathname.startsWith("/agents/"))
    return handleAgent(request, env, url);
  return problem("not-found", request);
}

// The only route that sets the cookie. Creates a session, or renews one that is
// close to expiry. An invalid or expired cookie is replaced with a fresh identity.
async function handleSession(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return problem("method-not-allowed", request);

  // The IP is only a rate limit key. It is never stored or logged.
  const ip = request.headers.get("cf-connecting-ip") ?? "local";
  const { success } = await env.SESSION_LIMITER.limit({ key: ip });
  if (!success) return problem("rate-limited", request);

  const now = nowSeconds();
  const current = await readSession(request, env, now);
  let issue: SessionPayload | null = null;
  if (!current.ok) issue = newSession(now);
  else if (needsRenewal(current.payload, now))
    issue = renewed(current.payload, now);

  const headers = new Headers({ "cache-control": NO_STORE });
  if (issue) {
    const token = await encodeSession(issue, env.SESSION_SECRET);
    headers.set("set-cookie", setCookieHeader(token, issue, env, now));
  }
  return new Response(null, { status: 204, headers });
}

async function handleAgent(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  // ["", "agents", "<class>", "<name>", ...rest]
  const [, , agentClass, name, ...rest] = url.pathname.split("/");
  if (agentClass !== AGENT_CLASS) return problem("forbidden", request);

  const session = await readSession(request, env, nowSeconds());
  if (!session.ok) return problem("unauthorized", request);
  const { sid, exp } = session.payload;
  if (name !== AGENT_ALIAS && name !== sid)
    return problem("forbidden", request);

  const upgrade = isWebSocketUpgrade(request);
  if (upgrade) {
    if (rest.length > 0) return problem("not-found", request);
    const { success } = await env.CONNECT_LIMITER.limit({ key: sid });
    if (!success) return problem("rate-limited", request);
  } else {
    if (request.method !== "GET") return problem("method-not-allowed", request);
    if (rest.join("/") !== "get-messages") return problem("not-found", request);
  }

  const target = new URL(url);
  target.pathname = ["", "agents", AGENT_CLASS, sid, ...rest].join("/");
  target.searchParams.delete(SESSION_EXP_PARAM);
  if (upgrade) target.searchParams.set(SESSION_EXP_PARAM, String(exp));

  const res = await routeAgentRequest(new Request(target, request), env);
  if (!res) return problem("not-found", request);
  if (upgrade) return res;

  const headers = new Headers(res.headers);
  headers.set("cache-control", NO_STORE);
  return new Response(res.body, { status: res.status, headers });
}
