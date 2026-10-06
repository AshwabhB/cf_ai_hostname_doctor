import {
  AIChatAgent,
  type ChatResponseResult,
  type OnChatMessageOptions
} from "@cloudflare/ai-chat";
import { callable, type Connection, type WSMessage } from "agents";
import { readSummaries, type HostnameSummary } from "./ai/context";
import { TurnLease } from "./ai/lease";
import { TurnQuota } from "./ai/quota";
import { killSwitchOn, runTurn } from "./ai/turn";
import { LIMITS } from "./config/limits";
import {
  SESSION_EXPIRED_CLOSE,
  TOO_MANY_SOCKETS_CLOSE,
  type HdErrorFrame
} from "./config/protocol";
import { SqlDnsCache } from "./dns/cache";
import { diagnose } from "./dns/diagnose";
import { DohClient, defaultDohDeps } from "./dns/doh";
import type { Diagnosis } from "./dns/diagnose";
import { DiagnosisService } from "./hostnames/diagnosis";
import { HostnameLifecycle, type WorkflowStatus } from "./hostnames/lifecycle";
import { migrate } from "./hostnames/schema";
import {
  HostnameService,
  type CommitEvent,
  type CreateInput,
  type HostnameView,
  type Result
} from "./hostnames/service";
import { SESSION_EXP_PARAM, handleRequest } from "./router";
import {
  log,
  visitorHash,
  withLogContext,
  type LogContext
} from "./observability/log";
import {
  FrameRateLimiter,
  checkFrame,
  rebuildChatRequest,
  utf8Length
} from "./security/frames";

function sendError(
  connection: Connection,
  status: number,
  title: string,
  retryAfter?: number
) {
  const frame: HdErrorFrame = { type: "hd_error", status, title };
  if (retryAfter !== undefined) frame.retry_after = retryAfter;
  connection.send(JSON.stringify(frame));
}

// Pushed to the visitor's own sockets with server setState after every change.
export type TenantState = {
  hostnames: HostnameSummary[];
  updated_at: string | null;
};

export class TenantAgent extends AIChatAgent<Env, TenantState> {
  initialState: TenantState = { hostnames: [], updated_at: null };

  // The instance name is the visitor's sid. The browser never needs it.
  static options = { sendIdentityOnConnect: false };

  // Durable chat recovery (stream resume after eviction) is always on in @cloudflare/ai-chat.
  maxPersistedMessages = LIMITS.chat.maxPersistedMessages;

  private frameLimiter = new FrameRateLimiter();
  private migrated = false;
  private _hostnames: HostnameService | null = null;
  private _diagnoses: DiagnosisService | null = null;
  private _hostnameLifecycle: HostnameLifecycle | null = null;
  // Keyed hash of this visitor's sid for log lines. Set in onStart.
  private visitorId: string | undefined;
  // Time limits for one model call. A field so tests can shorten them.
  chatTimeouts: { firstChunkMs: number; totalMs: number } = {
    firstChunkMs: LIMITS.chat.firstTokenMs,
    totalMs: LIMITS.chat.totalMs
  };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The SDK wraps onMessage in its constructors. Wrapping again here puts the
    // guard in front of state sync, RPC and the chat protocol.
    const sdkOnMessage = this.onMessage.bind(this);
    this.onMessage = (connection, message) =>
      this.guardFrame(connection, message, sdkOnMessage);
    // Counted from the SDK's connections, which come from the runtime's socket list and
    // so survive hibernation. The new socket is already accepted here, so one past the
    // limit is closed with 4429 and the browser stops reconnecting.
    const sdkOnConnect = this.onConnect.bind(this);
    this.onConnect = (connection, ctx) => {
      if (
        this.openSocketsBesides(connection) >= LIMITS.ws.maxSocketsPerVisitor
      ) {
        connection.close(TOO_MANY_SOCKETS_CLOSE, "too many open tabs");
        return;
      }
      return sdkOnConnect(connection, ctx);
    };
    const sdkOnClose = this.onClose.bind(this);
    this.onClose = (connection, code, reason, wasClean) => {
      this.frameLimiter.forget(connection.id);
      return sdkOnClose(connection, code, reason, wasClean);
    };
  }

  // Open sockets other than this one. A tab that reconnects reuses its connection id,
  // so a stale socket of the same tab is not counted against it.
  private openSocketsBesides(connection: Connection): number {
    let count = 0;
    for (const other of this.getConnections()) {
      if (other.id !== connection.id) count++;
    }
    return count;
  }

  private async guardFrame(
    connection: Connection,
    message: WSMessage,
    next: (connection: Connection, message: WSMessage) => void | Promise<void>
  ) {
    const exp = Number(
      new URL(connection.uri ?? "http://invalid/").searchParams.get(
        SESSION_EXP_PARAM
      )
    );
    if (!Number.isFinite(exp) || exp <= Math.floor(Date.now() / 1000)) {
      connection.close(SESSION_EXPIRED_CLOSE, "session expired");
      return;
    }
    // Cheap checks before spending a rate limit token or parsing.
    if (typeof message !== "string") {
      connection.close(1003, "binary frames not accepted");
      return;
    }
    if (utf8Length(message) > LIMITS.ws.maxFrameBytes) {
      connection.close(1009, "frame too large");
      return;
    }
    if (!this.frameLimiter.take(connection.id, Date.now())) {
      sendError(connection, 429, "too many frames");
      return;
    }

    const verdict = checkFrame(message);
    switch (verdict.kind) {
      case "close":
        connection.close(verdict.code, verdict.reason);
        return;
      case "reject":
        sendError(connection, verdict.status, verdict.title);
        return;
      case "chat": {
        if (this.messages.some((m) => m.id === verdict.message.id)) {
          sendError(connection, 400, "invalid chat request");
          return;
        }
        this.ensureSchema();
        const lease = new TurnLease(this.ctx.storage);
        if (!lease.acquire(verdict.requestId, Date.now())) {
          sendError(connection, 409, "a reply is already in progress");
          return;
        }
        // Taken before any model call, and counted per visitor across all sockets. With
        // the kill switch on no model runs, so no turn is used.
        if (!killSwitchOn(this.env)) {
          const quota = new TurnQuota(this.ctx.storage).take(Date.now());
          if (!quota.ok) {
            lease.release(verdict.requestId);
            this.traced(undefined, () =>
              log("model_call", { outcome: "quota_exceeded", latency_ms: 0 })
            );
            sendError(
              connection,
              429,
              "daily chat limit reached",
              quota.retryAfterSeconds
            );
            return;
          }
        }
        // The SDK handler resolves when the turn is over, however it ended.
        // onChatResponse releases too, and the expiry is only a backstop.
        // The turn's own id, not the browser's request id, ties its log lines together.
        try {
          return await this.traced(undefined, () =>
            next(
              connection,
              rebuildChatRequest(
                verdict.requestId,
                this.messages,
                verdict.message
              )
            )
          );
        } finally {
          lease.release(verdict.requestId);
        }
      }
      case "pass":
        return next(connection, message);
    }
  }

  async onStart(props?: object) {
    await super.onStart(props);
    this.visitorId = await visitorHash(this.env.SESSION_SECRET, this.name);
    this.ensureSchema();
    // The last pushed state is persisted. Rebuild it on start so clients never get a
    // copy shaped by older code or missing rows changed while the agent slept.
    this.publishState();
    // Reconcile on start, in the background so the first request is not held up.
    this.ctx.waitUntil(this.reconcile());
  }

  // Runs fn with this visitor and a correlation id on every log line it causes. A caller
  // inside our own code may pass its id, so one REST call or workflow run reads as one.
  private traced<T>(correlationId: string | undefined, fn: () => T): T {
    const ctx: LogContext = {
      visitor: this.visitorId,
      correlation_id: correlationId ?? crypto.randomUUID()
    };
    return withLogContext(ctx, fn);
  }

  private ensureSchema() {
    if (this.migrated) return;
    migrate(this.ctx.storage);
    this.migrated = true;
  }

  // One service for REST (via the Worker over RPC) and the @callable methods below.
  private get hostnames(): HostnameService {
    this.ensureSchema();
    this._hostnames ??= new HostnameService(this.ctx.storage, {
      register: (hostname) =>
        this.env.HostnameRegistry.getByName(hostname).register(),
      now: () => Date.now(),
      serviceZone: this.env.FALLBACK_ORIGIN,
      onCommitted: (event) => this.onHostnameCommitted(event)
    });
    return this._hostnames;
  }

  // Not named lifecycle: Agent already has a lifecycle property.
  private get hostnameLifecycle(): HostnameLifecycle {
    this._hostnameLifecycle ??= new HostnameLifecycle({
      tenantId: this.name,
      hostnames: this.hostnames,
      diagnoses: this.diagnoses,
      registry: (hostname) => {
        const stub = this.env.HostnameRegistry.getByName(hostname);
        return {
          claim: (tenant, generation) => stub.claim(tenant, generation),
          release: (tenant, generation) => stub.release(tenant, generation),
          owner: () => stub.owner()
        };
      },
      startWorkflow: async (id, params) => {
        // agentBinding is explicit so routing never depends on class names surviving
        // minification in the production build.
        await this.runWorkflow("VERIFY_WORKFLOW", params, {
          id,
          agentBinding: "TenantAgent"
        });
      },
      terminateWorkflow: async (id) => {
        const instance = await this.env.VERIFY_WORKFLOW.get(id);
        await instance.terminate();
      },
      workflowStatus: async (id): Promise<WorkflowStatus> => {
        try {
          const instance = await this.env.VERIFY_WORKFLOW.get(id);
          return (await instance.status()).status;
        } catch {
          return "missing";
        }
      },
      now: () => Date.now()
    });
    return this._hostnameLifecycle;
  }

  private async onHostnameCommitted(event: CommitEvent) {
    this.publishState();
    if (event.kind === "created" || event.kind === "retried") {
      await this.hostnameLifecycle.startVerification(event.hostname.id);
      await this.ensureReconcileSchedule();
    }
  }

  // Server-side setState only. Clients can never write state (validateStateChange).
  private publishState() {
    this.setState({
      hostnames: readSummaries(this.ctx.storage.sql, this.env.FALLBACK_ORIGIN),
      updated_at: new Date().toISOString()
    });
  }

  // Reconcile runs every 10 minutes only while this visitor has rows that need it.
  private async ensureReconcileSchedule() {
    await this.scheduleEvery(LIMITS.verify.reconcileEverySeconds, "reconcile");
  }

  async reconcile() {
    this.ensureSchema();
    const report = await this.traced(undefined, () =>
      this.hostnameLifecycle.reconcile()
    );
    if (this.hostnames.reconcileRows().length === 0) {
      for (const schedule of this.getSchedules()) {
        if (schedule.callback === "reconcile")
          await this.cancelSchedule(schedule.id);
      }
    } else {
      await this.ensureReconcileSchedule();
    }
    if (
      report.restarted.length +
        report.conflicted.length +
        report.finishedDeletes.length >
      0
    ) {
      this.publishState();
    }
    return report;
  }

  // ---- VerifyWorkflow callbacks over RPC. Not @callable, so browsers cannot reach them.
  wfLoad(hostnameId: string, generation: number) {
    return this.hostnameLifecycle.load(hostnameId, generation);
  }

  wfRecord(
    hostnameId: string,
    generation: number,
    diagnosis: Diagnosis & { checkedAt: number }
  ) {
    const result = this.hostnameLifecycle.record(
      hostnameId,
      generation,
      diagnosis
    );
    // New findings change the table's "checked" time and codes, so push them too.
    this.publishState();
    return result;
  }

  // The workflow passes its run id as the correlation id.
  wfGiveUp(hostnameId: string, generation: number, correlationId?: string) {
    return this.traced(correlationId, () =>
      this.hostnameLifecycle.giveUp(hostnameId, generation)
    );
  }

  wfSettle(
    hostnameId: string,
    generation: number,
    granted: boolean,
    correlationId?: string
  ) {
    return this.traced(correlationId, () =>
      this.hostnameLifecycle.settle(hostnameId, generation, granted)
    );
  }

  wfActivate(
    hostnameId: string,
    generation: number,
    issuedAtMs: number,
    correlationId?: string
  ) {
    return this.traced(correlationId, () =>
      this.hostnameLifecycle.activate(hostnameId, generation, issuedAtMs)
    );
  }

  private get diagnoses(): DiagnosisService {
    this.ensureSchema();
    this._diagnoses ??= new DiagnosisService(this.ctx.storage, {
      // A fresh client per diagnosis, so each one gets its own lookup budget.
      diagnose: ({ hostname, token }) =>
        diagnose(
          new DohClient(defaultDohDeps(new SqlDnsCache(this.ctx.storage.sql))),
          {
            hostname,
            token,
            fallbackOrigin: this.env.FALLBACK_ORIGIN
          }
        ),
      now: () => Date.now()
    });
    return this._diagnoses;
  }

  // RPC for the Worker's REST routes. Not @callable, so browsers cannot reach them.
  apiList(limit?: number, cursor?: string) {
    return this.hostnames.list({ limit, cursor });
  }

  apiGet(id: string) {
    return this.hostnames.get(id);
  }

  apiEvents(id: string, limit?: number, cursor?: string) {
    return this.hostnames.events(id, { limit, cursor });
  }

  // Writes take the Worker's correlation id, so a request and its transitions match.
  apiCreate(input: CreateInput, correlationId?: string) {
    return this.traced(correlationId, () => this.hostnames.create(input));
  }

  apiDelete(id: string, etag: string, correlationId?: string) {
    return this.traced(correlationId, () =>
      this.hostnameLifecycle.delete(id, etag)
    );
  }

  apiRetry(id: string, correlationId?: string) {
    return this.traced(correlationId, () => this.hostnames.retry(id, "user"));
  }

  apiCheck(id: string, correlationId?: string) {
    return this.traced(correlationId, async () => {
      const result = await this.diagnoses.check(id);
      if (result.ok) this.publishState();
      return result;
    });
  }

  apiDiagnosis(id: string) {
    return this.diagnoses.get(id);
  }

  // Browser-callable. Arguments are schema-checked by the frame guard (CALLABLES).
  @callable()
  confirmDelete(
    id: string,
    etag: string
  ): Promise<Result<{ hostname: HostnameView }>> {
    return this.traced(undefined, () =>
      this.hostnameLifecycle.delete(id, etag)
    );
  }

  // Named retryHostname because Agent already has a retry() helper.
  @callable()
  retryHostname(id: string): Promise<Result<{ hostname: HostnameView }>> {
    return this.traced(undefined, () => this.hostnames.retry(id, "user"));
  }

  // State only ever changes on the server.
  validateStateChange(_nextState: unknown, source: Connection | "server") {
    if (source !== "server") throw new Error("client state is read only");
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    return runTurn({
      env: this.env,
      storage: this.ctx.storage,
      messages: this.messages,
      hostnames: this.hostnames,
      diagnoses: this.diagnoses,
      requestId: options?.requestId ?? crypto.randomUUID(),
      sessionAffinity: this.sessionAffinity,
      abortSignal: options?.abortSignal,
      timeouts: this.chatTimeouts
    });
  }

  // Every turn ends here: completed, error or aborted (timeouts surface as errors).
  protected onChatResponse(result: ChatResponseResult) {
    this.ensureSchema();
    new TurnLease(this.ctx.storage).release(result.requestId);
  }
}

export { HostnameRegistry } from "./hostnames/registry";
export { VerifyWorkflow, type VerifyParams } from "./workflow/verify";

export default {
  fetch: handleRequest
} satisfies ExportedHandler<Env>;
