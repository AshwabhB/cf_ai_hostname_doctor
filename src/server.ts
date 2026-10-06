import {
  AIChatAgent,
  type ChatResponseResult,
  type OnChatMessageOptions
} from "@cloudflare/ai-chat";
import { callable, type Connection, type WSMessage } from "agents";
import {
  DurableObject,
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep
} from "cloudflare:workers";
import { TurnLease } from "./ai/lease";
import { runTurn } from "./ai/turn";
import { LIMITS } from "./config/limits";
import { SESSION_EXPIRED_CLOSE } from "./config/protocol";
import { SqlDnsCache } from "./dns/cache";
import { diagnose } from "./dns/diagnose";
import { DohClient, defaultDohDeps } from "./dns/doh";
import { DiagnosisService } from "./hostnames/diagnosis";
import { migrate } from "./hostnames/schema";
import {
  HostnameService,
  type CreateInput,
  type HostnameView,
  type Result
} from "./hostnames/service";
import { SESSION_EXP_PARAM, handleRequest } from "./router";
import {
  FrameRateLimiter,
  checkFrame,
  rebuildChatRequest,
  utf8Length
} from "./security/frames";

function sendError(connection: Connection, status: number, title: string) {
  connection.send(JSON.stringify({ type: "hd_error", status, title }));
}

export class TenantAgent extends AIChatAgent<Env> {
  // The instance name is the visitor's sid. The browser never needs it.
  static options = { sendIdentityOnConnect: false };

  // Durable chat recovery (stream resume after eviction) is always on in @cloudflare/ai-chat.
  maxPersistedMessages = LIMITS.chat.maxPersistedMessages;

  private frameLimiter = new FrameRateLimiter();
  private migrated = false;
  private _hostnames: HostnameService | null = null;
  private _diagnoses: DiagnosisService | null = null;
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
    const sdkOnClose = this.onClose.bind(this);
    this.onClose = (connection, code, reason, wasClean) => {
      this.frameLimiter.forget(connection.id);
      return sdkOnClose(connection, code, reason, wasClean);
    };
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
        // The SDK handler resolves when the turn is over, however it ended.
        // onChatResponse releases too, and the expiry is only a backstop.
        try {
          return await next(
            connection,
            rebuildChatRequest(
              verdict.requestId,
              this.messages,
              verdict.message
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
    this.ensureSchema();
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
      serviceZone: this.env.FALLBACK_ORIGIN
    });
    return this._hostnames;
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

  apiCreate(input: CreateInput) {
    return this.hostnames.create(input);
  }

  apiDelete(id: string, etag: string) {
    return this.hostnames.delete(id, etag, "user");
  }

  apiRetry(id: string) {
    return this.hostnames.retry(id, "user");
  }

  apiCheck(id: string) {
    return this.diagnoses.check(id);
  }

  apiDiagnosis(id: string) {
    return this.diagnoses.get(id);
  }

  // Browser-callable. Arguments are schema-checked by the frame guard (CALLABLES).
  @callable()
  confirmDelete(id: string, etag: string): Result<{ hostname: HostnameView }> {
    return this.hostnames.delete(id, etag, "user");
  }

  // Named retryHostname because Agent already has a retry() helper.
  @callable()
  retryHostname(id: string): Result<{ hostname: HostnameView }> {
    return this.hostnames.retry(id, "user");
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

// One per normalized hostname. S3 only hands out generations. Claim and release
// arrive in S6 and use the owner columns.
export class HostnameRegistry extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS ownership (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      next_generation INTEGER NOT NULL,
      owner_tenant TEXT,
      owner_generation INTEGER,
      updated_at INTEGER NOT NULL
    )`);
  }

  // Returns a fresh generation for this hostname. Monotonic and never reused.
  register(): number {
    const sql = this.ctx.storage.sql;
    return this.ctx.storage.transactionSync(() => {
      sql.exec(
        "INSERT OR IGNORE INTO ownership (id, next_generation, updated_at) VALUES (1, 1, ?)",
        Date.now()
      );
      const { next_generation } = sql
        .exec<{ next_generation: number }>(
          "SELECT next_generation FROM ownership WHERE id = 1"
        )
        .one();
      sql.exec(
        "UPDATE ownership SET next_generation = ?, updated_at = ? WHERE id = 1",
        next_generation + 1,
        Date.now()
      );
      return next_generation;
    });
  }
}

export type VerifyParams = {
  tenantId: string;
  hostnameId: string;
  hostname: string;
  generation: number;
  run: number;
};

// Background DNS verification. Implemented in S6.
export class VerifyWorkflow extends WorkflowEntrypoint<Env, VerifyParams> {
  async run(
    _event: WorkflowEvent<VerifyParams>,
    _step: WorkflowStep
  ): Promise<never> {
    throw new Error("VerifyWorkflow is not implemented until S6");
  }
}

export default {
  fetch: handleRequest
} satisfies ExportedHandler<Env>;
