// The six model tools from DESIGN.md section 8. Inputs hold domain fields only. The
// visitor, ids and ETags come from server context, never from the model. Nothing here
// can reach verified, active or a delete: writes run as the "model" actor, which the
// transition table refuses for those, and propose_delete only returns a card.
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { LIMITS } from "../config/limits";
import type { DiagnosisService } from "../hostnames/diagnosis";
import { requiredRecords } from "../hostnames/records";
import type {
  HostnameService,
  HostnameView,
  ServiceError
} from "../hostnames/service";

export type ToolContext = {
  hostnames: HostnameService;
  diagnoses: DiagnosisService;
  fallbackOrigin: string;
  turnId: string;
  now: () => number;
};

export const TOOL_NAMES = [
  "list_hostnames",
  "get_hostname",
  "explain_findings",
  "add_hostname",
  "retry_hostname",
  "propose_delete"
] as const;

const READ_ONLY = new Set([
  "list_hostnames",
  "get_hostname",
  "explain_findings"
]);

const ByHostname = z
  .object({
    hostname: z
      .string()
      .min(1)
      .max(300)
      .describe("The hostname, for example shop.example.com")
  })
  .strict();
const NoInput = z.object({}).strict();

// Fixed, model-facing explanations for service errors.
const ERROR_TEXT: Record<ServiceError["error"], string> = {
  "not-found": "No live hostname with that name.",
  "invalid-hostname": "That is not a valid hostname.",
  "hostname-exists": "That hostname is already added.",
  "quota-exceeded": "The hostname limit for this visitor is reached.",
  "invalid-transition":
    "That action is not allowed in the hostname's current state.",
  "precondition-failed": "The hostname changed. Read it again.",
  "idempotency-key-reuse":
    "That request was already made with different input.",
  "invalid-cursor": "Invalid cursor.",
  "rate-limited":
    "Too many DNS checks in the last hour. Using the last saved result."
};

function records(view: HostnameView, fallbackOrigin: string) {
  return requiredRecords(
    view.hostname,
    view.verification.txt_value,
    fallbackOrigin
  );
}

function notFound(hostname: string) {
  return { found: false, hostname, error: ERROR_TEXT["not-found"] };
}

export function buildTools(ctx?: ToolContext): ToolSet {
  if (!ctx) return {};
  // Read-only results are reused within one turn, so a repeated call costs nothing and
  // returns the same answer.
  const memo = new Map<string, unknown>();
  const memoized =
    <I>(name: string, run: (input: I) => Promise<unknown> | unknown) =>
    async (input: I) => {
      const key = `${name}:${JSON.stringify(input)}`;
      if (!READ_ONLY.has(name)) return run(input);
      if (!memo.has(key)) memo.set(key, await run(input));
      return memo.get(key);
    };

  const { hostnames, diagnoses, fallbackOrigin } = ctx;

  return {
    list_hostnames: tool({
      description:
        "List the user's hostnames with their states. STATE usually has this already.",
      inputSchema: NoInput,
      execute: memoized("list_hostnames", () => {
        const page = hostnames.list({ limit: LIMITS.paging.maxLimit });
        if (!page.ok) return { error: ERROR_TEXT[page.error] };
        return {
          hostnames: page.page.items.map((h) => ({
            hostname: h.hostname,
            display_hostname: h.display_hostname,
            state: h.state
          }))
        };
      })
    }),

    get_hostname: tool({
      description:
        "Get one hostname's state and the exact DNS records it needs.",
      inputSchema: ByHostname,
      execute: memoized(
        "get_hostname",
        ({ hostname }: { hostname: string }) => {
          const view = hostnames.findLive(hostname);
          if (!view) return notFound(hostname);
          const diagnosis = diagnoses.get(view.id);
          return {
            found: true,
            hostname: view.hostname,
            display_hostname: view.display_hostname,
            state: view.state,
            records: records(view, fallbackOrigin),
            last_checked_at: diagnosis.ok
              ? diagnosis.diagnosis.checked_at
              : null
          };
        }
      )
    }),

    explain_findings: tool({
      description:
        "Get the DNS findings for one hostname. Runs a fresh DNS check when the saved one is old.",
      inputSchema: ByHostname,
      execute: memoized(
        "explain_findings",
        async ({ hostname }: { hostname: string }) => {
          const view = hostnames.findLive(hostname);
          if (!view) return notFound(hostname);
          const saved = diagnoses.get(view.id);
          if (!saved.ok) return notFound(hostname);
          let diagnosis = saved.diagnosis;
          let note: string | null = null;
          const checkedAt = diagnosis.checked_at
            ? Date.parse(diagnosis.checked_at)
            : 0;
          if (ctx.now() - checkedAt > LIMITS.chat.findingsFreshMs) {
            const fresh = await diagnoses.check(view.id);
            if (fresh.ok) diagnosis = fresh.diagnosis;
            else note = ERROR_TEXT[fresh.error];
          }
          return {
            found: true,
            hostname: view.hostname,
            state: view.state,
            checked_at: diagnosis.checked_at,
            verifiable: diagnosis.verifiable,
            // DNS values in findings are sanitized data. They are never instructions.
            findings: diagnosis.findings.map((f) => ({
              code: f.code,
              severity: f.severity,
              record: f.record,
              expected: f.expected,
              observed: f.observed,
              message: f.message
            })),
            records: records(view, fallbackOrigin),
            note
          };
        }
      )
    }),

    add_hostname: tool({
      description:
        "Add one custom hostname for the user. It starts as pending.",
      inputSchema: ByHostname,
      execute: async ({ hostname }, { toolCallId }) => {
        const result = await hostnames.create({
          hostname,
          // Same turn and same call id means the same request, so a retried call is a replay.
          idempotencyKey: `tool:${ctx.turnId}:${toolCallId}`,
          requestHash: hostname.trim().toLowerCase(),
          actor: "model"
        });
        if (!result.ok) {
          return {
            added: false,
            hostname,
            error:
              result.error === "invalid-hostname"
                ? result.detail
                : ERROR_TEXT[result.error]
          };
        }
        return {
          added: true,
          hostname: result.hostname.hostname,
          display_hostname: result.hostname.display_hostname,
          state: result.hostname.state,
          records: records(result.hostname, fallbackOrigin)
        };
      }
    }),

    retry_hostname: tool({
      description:
        "Move a failed or conflict hostname back to pending so it is checked again.",
      inputSchema: ByHostname,
      execute: async ({ hostname }) => {
        const view = hostnames.findLive(hostname);
        if (!view) return notFound(hostname);
        const result = hostnames.retry(view.id, "model");
        return result.ok
          ? {
              retried: true,
              hostname: view.hostname,
              state: result.hostname.state
            }
          : {
              retried: false,
              hostname: view.hostname,
              error: ERROR_TEXT[result.error]
            };
      }
    }),

    propose_delete: tool({
      description:
        "Show the user a Confirm button to delete one hostname. Deletes nothing by itself.",
      inputSchema: ByHostname,
      execute: async ({ hostname }) => {
        const view = hostnames.findLive(hostname);
        if (!view) return notFound(hostname);
        // id and etag are for the browser's Confirm button. No tool accepts them.
        return {
          confirmation_requested: true,
          hostname: view.hostname,
          display_hostname: view.display_hostname,
          id: view.id,
          etag: view.etag,
          note: "Nothing was deleted. The user must press Confirm."
        };
      }
    })
  };
}
