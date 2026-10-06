// REST v1 for hostnames (DESIGN.md section 5). The Worker parses and validates HTTP,
// then calls the visitor's TenantAgent over RPC. The cookie has been checked by the router.
import { getAgentByName } from "agents";
import { z } from "zod";
import { LIMITS } from "../config/limits";
import type { Result, ServiceError } from "../hostnames/service";
import {
  BodyTooLargeError,
  NO_STORE,
  problem,
  readBodyCapped
} from "../security/http";

export const HOSTNAMES_PATH = "/api/v1/hostnames";

const CreateBody = z
  .object({ hostname: z.string().max(LIMITS.hostnames.maxInputChars) })
  .strict();

const ListQuery = z
  .object({
    limit: z
      .string()
      .regex(/^[1-9][0-9]{0,2}$/)
      .transform(Number)
      .optional(),
    cursor: z.string().min(1).max(200).optional()
  })
  .strict();

const IdempotencyKey = z
  .string()
  .min(1)
  .max(LIMITS.idempotency.maxKeyChars)
  .regex(/^[A-Za-z0-9._:-]+$/);

function json(
  body: unknown,
  status: number,
  headers: HeadersInit = {}
): Response {
  const h = new Headers(headers);
  h.set("content-type", "application/json");
  h.set("cache-control", NO_STORE);
  return new Response(JSON.stringify(body), { status, headers: h });
}

function fromServiceError(error: ServiceError, request: Request): Response {
  switch (error.error) {
    case "invalid-hostname":
      return problem("invalid-hostname", request, error.detail);
    case "precondition-failed":
      return problem("precondition-failed", request);
    default:
      return problem(error.error, request);
  }
}

function query(url: URL) {
  return ListQuery.safeParse(Object.fromEntries(url.searchParams));
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

type Unwrapped<T> = Result<T>;

export async function handleHostnames(
  request: Request,
  env: Env,
  url: URL,
  sid: string
): Promise<Response> {
  const { success } = await env.API_LIMITER.limit({ key: sid });
  if (!success) return problem("rate-limited", request);

  // ["", "api", "v1", "hostnames", ...rest]
  const rest = url.pathname.split("/").slice(4);
  if (rest.at(-1) === "") rest.pop();
  const agent = await getAgentByName(env.TenantAgent, sid);
  const method = request.method;

  if (rest.length === 0) {
    if (method === "GET") {
      const q = query(url);
      if (!q.success)
        return problem("bad-request", request, "Unsupported query parameters.");
      const result = (await agent.apiList(
        q.data.limit,
        q.data.cursor
      )) as Unwrapped<{
        page: unknown;
      }>;
      return result.ok
        ? json(result.page, 200)
        : fromServiceError(result, request);
    }
    if (method === "POST") return create(request, agent);
    return problem("method-not-allowed", request);
  }

  const [id, sub, ...extra] = rest;
  if (extra.length > 0 || id === "") return problem("not-found", request);

  if (sub === undefined) {
    if (method === "GET") {
      if ([...url.searchParams.keys()].length > 0) {
        return problem("bad-request", request, "Unsupported query parameters.");
      }
      const result = await agent.apiGet(id);
      if (!result.ok) return fromServiceError(result, request);
      const etag = result.hostname.etag;
      if (request.headers.get("if-none-match") === etag) {
        return new Response(null, {
          status: 304,
          headers: { etag, "cache-control": NO_STORE }
        });
      }
      return json(result.hostname, 200, { etag });
    }
    if (method === "DELETE") {
      const ifMatch = request.headers.get("if-match");
      if (!ifMatch)
        return problem(
          "precondition-required",
          request,
          "Send If-Match with the hostname's ETag."
        );
      const result = await agent.apiDelete(id, ifMatch);
      return result.ok
        ? json(result.hostname, 202, { etag: result.hostname.etag })
        : fromServiceError(result, request);
    }
    return problem("method-not-allowed", request);
  }

  if (sub === "events") {
    if (method !== "GET") return problem("method-not-allowed", request);
    const q = query(url);
    if (!q.success)
      return problem("bad-request", request, "Unsupported query parameters.");
    const result = await agent.apiEvents(id, q.data.limit, q.data.cursor);
    return result.ok
      ? json(result.page, 200)
      : fromServiceError(result, request);
  }

  if (sub === "check") {
    if (method !== "POST") return problem("method-not-allowed", request);
    const result = await agent.apiCheck(id);
    return result.ok
      ? json(result.diagnosis, 200, { etag: result.diagnosis.etag })
      : fromServiceError(result, request);
  }

  if (sub === "diagnosis") {
    if (method !== "GET") return problem("method-not-allowed", request);
    if ([...url.searchParams.keys()].length > 0) {
      return problem("bad-request", request, "Unsupported query parameters.");
    }
    const result = await agent.apiDiagnosis(id);
    if (!result.ok) return fromServiceError(result, request);
    const etag = result.diagnosis.etag;
    if (request.headers.get("if-none-match") === etag) {
      return new Response(null, {
        status: 304,
        headers: { etag, "cache-control": NO_STORE }
      });
    }
    return json(result.diagnosis, 200, { etag });
  }

  if (sub === "retry") {
    if (method !== "POST") return problem("method-not-allowed", request);
    const result = await agent.apiRetry(id);
    return result.ok
      ? json(result.hostname, 200, { etag: result.hostname.etag })
      : fromServiceError(result, request);
  }

  return problem("not-found", request);
}

async function create(
  request: Request,
  agent: Awaited<
    ReturnType<typeof getAgentByName<Env, import("../server").TenantAgent>>
  >
): Promise<Response> {
  const keyHeader = request.headers.get("idempotency-key");
  if (keyHeader === null) {
    return problem(
      "precondition-required",
      request,
      "Send an Idempotency-Key header."
    );
  }
  const key = IdempotencyKey.safeParse(keyHeader);
  if (!key.success)
    return problem("bad-request", request, "Invalid Idempotency-Key header.");
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  ) {
    return problem("bad-request", request, "Send a JSON body.");
  }

  let text: string;
  try {
    text = await readBodyCapped(request, LIMITS.http.maxBodyBytes);
  } catch (e) {
    if (e instanceof BodyTooLargeError)
      return problem("payload-too-large", request);
    return problem("bad-request", request);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return problem("bad-request", request, "Body is not valid JSON.");
  }
  const parsed = CreateBody.safeParse(body);
  if (!parsed.success)
    return problem(
      "bad-request",
      request,
      'Body must be { "hostname": string }.'
    );

  const result = await agent.apiCreate({
    hostname: parsed.data.hostname,
    idempotencyKey: key.data,
    requestHash: await sha256Hex(JSON.stringify(parsed.data)),
    actor: "user"
  });
  if (!result.ok) return fromServiceError(result, request);
  const headers: Record<string, string> = {
    etag: result.hostname.etag,
    location: `${HOSTNAMES_PATH}/${result.hostname.id}`
  };
  if (result.replayed) headers["idempotent-replayed"] = "true";
  return json(result.hostname, 201, headers);
}
