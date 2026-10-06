// Hostname rows for one visitor. REST (through the Worker) and @callable methods both
// call this. Every state change goes through transition(), which checks the section 2
// table, the generation and the version at commit, and writes the row and its event
// in one transaction.
//
// Durable Object input gates already serialize code that only touches storage. The
// race that remains is across awaited calls (create awaits the registry), so anything
// read before an await is checked again inside the commit transaction.
import { z } from "zod";
import { LIMITS } from "../config/limits";
import { NORMALIZE_MESSAGES, normalizeHostname } from "./normalize";
import {
  CREATE_ACTORS,
  isAllowed,
  type Actor,
  type HostnameState
} from "./state-machine";
import { log, type LogFields } from "../observability/log";

export const TXT_PREFIX = "_cf-custom-hostname";
const ID_PATTERN = /^hn_[0-9a-f]{24}$/;

type Row = {
  id: string;
  hostname: string;
  generation: number;
  state: HostnameState;
  version: number;
  verify_token: string;
  certificate_json: string | null;
  created_at: number;
  updated_at: number;
};

const ROW_COLUMNS =
  "id, hostname, generation, state, version, verify_token, certificate_json, created_at, updated_at";

// Simulated certificates only. Nothing is ever issued by a real certificate authority.
export type CertificateView = {
  simulated: true;
  issuer: "Simulated";
  issued_at: string;
  not_after: string;
};

// What reconcile and the workflow need beyond the public view.
export type WorkflowRow = {
  id: string;
  hostname: string;
  generation: number;
  state: HostnameState;
  verify_token: string;
  workflow_instance_id: string | null;
  workflow_run: number;
  workflow_started_at: number | null;
  last_checked_at: number | null;
  registry_released: number;
  updated_at: number;
};

export type CommitEvent = {
  kind: "created" | "retried" | "transitioned";
  hostname: HostnameView;
};

type EventRow = {
  id: number;
  from_state: HostnameState | null;
  to_state: HostnameState;
  actor: Actor;
  reason: string | null;
  at: number;
};

export type HostnameView = {
  id: string;
  hostname: string;
  display_hostname: string;
  state: HostnameState;
  generation: number;
  version: number;
  etag: string;
  verification: { txt_name: string; txt_value: string };
  certificate: CertificateView | null;
  created_at: string;
  updated_at: string;
};

export type EventView = {
  id: number;
  from_state: HostnameState | null;
  to_state: HostnameState;
  actor: Actor;
  reason: string | null;
  at: string;
};

export type Page<T> = { items: T[]; next_cursor: string | null };

export type ServiceError =
  | { error: "not-found" }
  | { error: "invalid-hostname"; detail: string }
  | { error: "hostname-exists" }
  | { error: "quota-exceeded" }
  | { error: "invalid-transition" }
  | { error: "precondition-failed"; detail: "version" | "generation" }
  | { error: "idempotency-key-reuse" }
  | { error: "invalid-cursor" }
  | { error: "rate-limited" };

export type Result<T> = ({ ok: true } & T) | ({ ok: false } & ServiceError);

export type CreateInput = {
  hostname: string;
  idempotencyKey: string;
  requestHash: string;
  actor: Actor;
};

export type ServiceDeps = {
  // Asks the HostnameRegistry for a fresh, never reused generation.
  register(hostname: string): Promise<number>;
  now(): number;
  // FALLBACK_ORIGIN. It and every name under it cannot be added as custom hostnames.
  serviceZone?: string;
  // Called after a create, retry or transition commits. TenantAgent uses it to start the
  // verification workflow and to push the hostname summary to open sockets.
  onCommitted?: (event: CommitEvent) => void | Promise<void>;
};

const err = <E extends ServiceError>(e: E) => ({ ok: false as const, ...e });

export function etagFor(id: string, version: number): string {
  return `"${id}.${version}"`;
}

// Accepts exactly the ETag this service issues for the given id.
export function versionFromEtag(etag: string, id: string): number | null {
  const match = /^"(hn_[0-9a-f]{24})\.([1-9][0-9]{0,9})"$/.exec(etag.trim());
  if (!match || match[1] !== id) return null;
  return Number(match[2]);
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

function toView(row: Row): HostnameView {
  const display = normalizeHostname(row.hostname);
  return {
    id: row.id,
    hostname: row.hostname,
    display_hostname: display.ok ? display.unicode : row.hostname,
    state: row.state,
    generation: row.generation,
    version: row.version,
    etag: etagFor(row.id, row.version),
    verification: {
      txt_name: `${TXT_PREFIX}.${row.hostname}`,
      txt_value: row.verify_token
    },
    certificate: row.certificate_json
      ? (JSON.parse(row.certificate_json) as CertificateView)
      : null,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString()
  };
}

function toEventView(row: EventRow): EventView {
  return { ...row, at: new Date(row.at).toISOString() };
}

const HostnameCursor = z
  .object({
    c: z.number().int().nonnegative(),
    i: z.string().regex(ID_PATTERN)
  })
  .strict();
const EventCursor = z.object({ e: z.number().int().positive() }).strict();

function encodeCursor(value: object): string {
  return btoa(JSON.stringify(value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decodeCursor<T>(cursor: string, schema: z.ZodType<T>): T | null {
  if (
    cursor.length > LIMITS.paging.maxCursorChars ||
    !/^[A-Za-z0-9_-]+$/.test(cursor)
  )
    return null;
  try {
    const json = atob(cursor.replace(/-/g, "+").replace(/_/g, "/"));
    const parsed = schema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function clampLimit(limit: number | undefined): number {
  const { defaultLimit, maxLimit } = LIMITS.paging;
  if (limit === undefined) return defaultLimit;
  return Math.min(Math.max(1, Math.trunc(limit)), maxLimit);
}

export class HostnameService {
  // Transitions written by the open transaction, logged after it commits.
  private pendingTransitions: LogFields[] = [];

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly deps: ServiceDeps
  ) {}

  private get sql() {
    return this.storage.sql;
  }

  private row(id: string): Row | null {
    if (!ID_PATTERN.test(id)) return null;
    return (
      this.sql
        .exec<Row>(`SELECT ${ROW_COLUMNS} FROM hostnames WHERE id = ?`, id)
        .toArray()[0] ?? null
    );
  }

  private liveCount(): number {
    return this.sql
      .exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM hostnames WHERE state <> 'deleted'"
      )
      .one().n;
  }

  private liveExists(hostname: string): boolean {
    return (
      this.sql
        .exec(
          "SELECT 1 FROM hostnames WHERE hostname = ? AND state <> 'deleted'",
          hostname
        )
        .toArray().length > 0
    );
  }

  private storedKey(
    key: string
  ): { request_hash: string; response_json: string } | null {
    return (
      this.sql
        .exec<{ request_hash: string; response_json: string }>(
          "SELECT request_hash, response_json FROM idempotency_keys WHERE key = ?",
          key
        )
        .toArray()[0] ?? null
    );
  }

  private replay(
    key: string,
    requestHash: string
  ): Result<{ hostname: HostnameView; replayed: boolean }> | null {
    const stored = this.storedKey(key);
    if (!stored) return null;
    if (stored.request_hash !== requestHash)
      return err({ error: "idempotency-key-reuse" });
    return {
      ok: true,
      hostname: JSON.parse(stored.response_json) as HostnameView,
      replayed: true
    };
  }

  // The live row for a hostname as a person or the model would type it.
  findLive(input: string): HostnameView | null {
    const normalized = normalizeHostname(input);
    if (!normalized.ok) return null;
    const row = this.sql
      .exec<Row>(
        `SELECT ${ROW_COLUMNS} FROM hostnames WHERE hostname = ? AND state <> 'deleted'`,
        normalized.ascii
      )
      .toArray()[0];
    return row ? toView(row) : null;
  }

  // The id of the live row for a hostname, for log lines. Not a tool read, so it does not
  // count against the per-turn memo.
  liveId(input: string): string | undefined {
    const normalized = normalizeHostname(input);
    if (!normalized.ok) return undefined;
    return this.sql
      .exec<{ id: string }>(
        "SELECT id FROM hostnames WHERE hostname = ? AND state <> 'deleted'",
        normalized.ascii
      )
      .toArray()[0]?.id;
  }

  get(id: string): Result<{ hostname: HostnameView }> {
    const row = this.row(id);
    return row
      ? { ok: true, hostname: toView(row) }
      : err({ error: "not-found" });
  }

  list(options: {
    limit?: number;
    cursor?: string;
  }): Result<{ page: Page<HostnameView> }> {
    const limit = clampLimit(options.limit);
    let after: { c: number; i: string } | null = null;
    if (options.cursor !== undefined) {
      after = decodeCursor(options.cursor, HostnameCursor);
      if (!after) return err({ error: "invalid-cursor" });
    }
    // Newest first. created_at only grows (see create), so rows added while a client
    // pages always sort before its cursor and never shift later pages.
    const rows = after
      ? this.sql
          .exec<Row>(
            `SELECT ${ROW_COLUMNS}
             FROM hostnames WHERE state <> 'deleted' AND (created_at, id) < (?, ?)
             ORDER BY created_at DESC, id DESC LIMIT ?`,
            after.c,
            after.i,
            limit + 1
          )
          .toArray()
      : this.sql
          .exec<Row>(
            `SELECT ${ROW_COLUMNS}
             FROM hostnames WHERE state <> 'deleted'
             ORDER BY created_at DESC, id DESC LIMIT ?`,
            limit + 1
          )
          .toArray();
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    const next_cursor =
      rows.length > limit && last
        ? encodeCursor({ c: last.created_at, i: last.id })
        : null;
    return { ok: true, page: { items: items.map(toView), next_cursor } };
  }

  events(
    id: string,
    options: { limit?: number; cursor?: string }
  ): Result<{ page: Page<EventView> }> {
    if (!this.row(id)) return err({ error: "not-found" });
    const limit = clampLimit(options.limit);
    let afterId = 0;
    if (options.cursor !== undefined) {
      const decoded = decodeCursor(options.cursor, EventCursor);
      if (!decoded) return err({ error: "invalid-cursor" });
      afterId = decoded.e;
    }
    const rows = this.sql
      .exec<EventRow>(
        "SELECT id, from_state, to_state, actor, reason, at FROM events WHERE hostname_id = ? AND id > ? ORDER BY id ASC LIMIT ?",
        id,
        afterId,
        limit + 1
      )
      .toArray();
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    const next_cursor =
      rows.length > limit && last ? encodeCursor({ e: last.id }) : null;
    return { ok: true, page: { items: items.map(toEventView), next_cursor } };
  }

  async create(
    input: CreateInput
  ): Promise<Result<{ hostname: HostnameView; replayed: boolean }>> {
    const result = await this.createRow(input);
    if (result.ok && !result.replayed) {
      await this.deps.onCommitted?.({
        kind: "created",
        hostname: result.hostname
      });
    }
    return result;
  }

  private async createRow(
    input: CreateInput
  ): Promise<Result<{ hostname: HostnameView; replayed: boolean }>> {
    if (!CREATE_ACTORS.includes(input.actor))
      return err({ error: "invalid-transition" });
    this.sweepIdempotency();
    const early = this.replay(input.idempotencyKey, input.requestHash);
    if (early) return early;

    const normalized = normalizeHostname(input.hostname, {
      serviceZone: this.deps.serviceZone
    });
    if (!normalized.ok) {
      return err({
        error: "invalid-hostname",
        detail: NORMALIZE_MESSAGES[normalized.error]
      });
    }
    const hostname = normalized.ascii;
    if (this.liveExists(hostname)) return err({ error: "hostname-exists" });
    if (this.liveCount() >= LIMITS.hostnames.maxPerVisitor)
      return err({ error: "quota-exceeded" });

    const generation = await this.deps.register(hostname);

    // Anything read above may have changed while we awaited, so check it all again.
    return this.committed(() => {
      const raced = this.replay(input.idempotencyKey, input.requestHash);
      if (raced) return raced;
      if (this.liveExists(hostname)) return err({ error: "hostname-exists" });
      if (this.liveCount() >= LIMITS.hostnames.maxPerVisitor) {
        return err({ error: "quota-exceeded" });
      }

      const now = this.deps.now();
      const newest =
        this.sql
          .exec<{ m: number | null }>(
            "SELECT MAX(created_at) AS m FROM hostnames"
          )
          .one().m ?? 0;
      const createdAt = Math.max(now, newest + 1);
      const row: Row = {
        id: `hn_${randomHex(12)}`,
        hostname,
        generation,
        state: "pending",
        version: 1,
        verify_token: randomHex(LIMITS.hostnames.verifyTokenBytes),
        certificate_json: null,
        created_at: createdAt,
        updated_at: createdAt
      };
      this.sql.exec(
        `INSERT INTO hostnames (id, hostname, generation, state, version, verify_token, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        row.id,
        row.hostname,
        row.generation,
        row.state,
        row.version,
        row.verify_token,
        row.created_at,
        row.updated_at
      );
      this.insertEvent(
        row.id,
        generation,
        null,
        "pending",
        input.actor,
        "created",
        createdAt
      );

      const view = toView(row);
      this.sql.exec(
        "INSERT INTO idempotency_keys (key, request_hash, status, response_json, created_at) VALUES (?, ?, ?, ?, ?)",
        input.idempotencyKey,
        input.requestHash,
        201,
        JSON.stringify(view),
        now
      );
      this.sql.exec(
        `DELETE FROM idempotency_keys WHERE key IN (
           SELECT key FROM idempotency_keys ORDER BY created_at DESC, key DESC LIMIT -1 OFFSET ?
         )`,
        LIMITS.idempotency.maxRows
      );
      return { ok: true as const, hostname: view, replayed: false };
    });
  }

  // The only way a row changes state.
  transition(
    id: string,
    to: HostnameState,
    actor: Actor,
    expected: { generation: number; version: number },
    reason: string | null = null,
    extra: { certificate?: CertificateView } = {}
  ): Result<{ hostname: HostnameView }> {
    const result = this.commitTransition(
      id,
      to,
      actor,
      expected,
      reason,
      extra
    );
    if (result.ok)
      void this.deps.onCommitted?.({
        kind: "transitioned",
        hostname: result.hostname
      });
    return result;
  }

  private commitTransition(
    id: string,
    to: HostnameState,
    actor: Actor,
    expected: { generation: number; version: number },
    reason: string | null,
    extra: { certificate?: CertificateView }
  ): Result<{ hostname: HostnameView }> {
    return this.committed(() => {
      const row = this.row(id);
      if (!row) return err({ error: "not-found" });
      if (row.generation !== expected.generation) {
        return err({ error: "precondition-failed", detail: "generation" });
      }
      if (row.version !== expected.version) {
        return err({ error: "precondition-failed", detail: "version" });
      }
      if (!isAllowed(row.state, to, actor))
        return err({ error: "invalid-transition" });

      const now = Math.max(this.deps.now(), row.updated_at);
      const certificateJson = extra.certificate
        ? JSON.stringify(extra.certificate)
        : null;
      this.sql.exec(
        "UPDATE hostnames SET state = ?, version = version + 1, updated_at = ?, certificate_json = COALESCE(?, certificate_json) WHERE id = ? AND generation = ? AND version = ?",
        to,
        now,
        certificateJson,
        id,
        expected.generation,
        expected.version
      );
      // changes() counts table rows only. rowsWritten would include index writes.
      const changed = this.sql
        .exec<{ n: number }>("SELECT changes() AS n")
        .one().n;
      if (changed !== 1)
        return err({ error: "precondition-failed", detail: "version" });
      this.insertEvent(id, row.generation, row.state, to, actor, reason, now);
      return {
        ok: true as const,
        hostname: toView({
          ...row,
          state: to,
          version: row.version + 1,
          certificate_json: certificateJson ?? row.certificate_json,
          updated_at: now
        })
      };
    });
  }

  async retry(
    id: string,
    actor: Actor
  ): Promise<Result<{ hostname: HostnameView }>> {
    const row = this.row(id);
    if (!row) return err({ error: "not-found" });
    const result = this.transition(
      id,
      "pending",
      actor,
      row,
      "retry requested"
    );
    if (result.ok)
      await this.deps.onCommitted?.({
        kind: "retried",
        hostname: result.hostname
      });
    return result;
  }

  // A system move fenced by generation and by the state the caller expects. The version
  // is read inside the same transaction, so a concurrent change makes this a no-op.
  systemTransition(
    id: string,
    generation: number,
    from: readonly HostnameState[],
    to: HostnameState,
    reason: string,
    extra: { certificate?: CertificateView } = {}
  ): Result<{ hostname: HostnameView }> {
    const row = this.row(id);
    if (!row) return err({ error: "not-found" });
    if (row.generation !== generation) {
      return err({ error: "precondition-failed", detail: "generation" });
    }
    if (!from.includes(row.state)) return err({ error: "invalid-transition" });
    return this.transition(id, to, "system", row, reason, extra);
  }

  // First half of a delete: the caller's ETag moves the row to deleting.
  beginDelete(
    id: string,
    etag: string,
    actor: Actor
  ): Result<{ hostname: HostnameView }> {
    const row = this.row(id);
    if (!row) return err({ error: "not-found" });
    const version = versionFromEtag(etag, id);
    if (version === null || version !== row.version) {
      return err({ error: "precondition-failed", detail: "version" });
    }
    return this.transition(
      id,
      "deleting",
      actor,
      { generation: row.generation, version },
      "delete confirmed"
    );
  }

  // Second half, once the workflow is stopped and the registry claim released.
  finishDelete(
    id: string,
    generation: number,
    reason: string
  ): Result<{ hostname: HostnameView }> {
    const result = this.systemTransition(
      id,
      generation,
      ["deleting"],
      "deleted",
      reason
    );
    if (result.ok) this.markReleased(id, generation);
    return result;
  }

  // Both halves with nothing to stop or release in between. TenantAgent.deleteHostname
  // is the production path, with the workflow and registry steps in the middle.
  delete(
    id: string,
    etag: string,
    actor: Actor
  ): Result<{ hostname: HostnameView }> {
    const deleting = this.beginDelete(id, etag, actor);
    if (!deleting.ok) return deleting;
    return this.finishDelete(
      id,
      deleting.hostname.generation,
      "nothing held in the registry"
    );
  }

  workflowRow(id: string): WorkflowRow | null {
    if (!ID_PATTERN.test(id)) return null;
    return (
      this.sql
        .exec<WorkflowRow>(
          `SELECT id, hostname, generation, state, verify_token, workflow_instance_id,
                  workflow_run, workflow_started_at, last_checked_at, registry_released, updated_at
           FROM hostnames WHERE id = ?`,
          id
        )
        .toArray()[0] ?? null
    );
  }

  // Rows reconcile must look at: everything live, and deleted rows whose registry claim
  // has not been confirmed released.
  reconcileRows(): WorkflowRow[] {
    return this.sql
      .exec<WorkflowRow>(
        `SELECT id, hostname, generation, state, verify_token, workflow_instance_id,
                workflow_run, workflow_started_at, last_checked_at, registry_released, updated_at
         FROM hostnames WHERE state <> 'deleted' OR registry_released = 0`
      )
      .toArray();
  }

  setWorkflow(
    id: string,
    generation: number,
    instanceId: string,
    run: number
  ): boolean {
    this.sql.exec(
      "UPDATE hostnames SET workflow_instance_id = ?, workflow_run = ?, workflow_started_at = ? WHERE id = ? AND generation = ?",
      instanceId,
      run,
      this.deps.now(),
      id,
      generation
    );
    return this.sql.exec<{ n: number }>("SELECT changes() AS n").one().n === 1;
  }

  markReleased(id: string, generation: number): void {
    this.sql.exec(
      "UPDATE hostnames SET registry_released = 1 WHERE id = ? AND generation = ?",
      id,
      generation
    );
  }

  // Runs fn in a transaction and logs its transitions only once it has committed.
  private committed<T>(fn: () => T): T {
    this.pendingTransitions = [];
    try {
      const result = this.storage.transactionSync(fn);
      for (const fields of this.pendingTransitions) log("transition", fields);
      return result;
    } finally {
      this.pendingTransitions = [];
    }
  }

  private insertEvent(
    hostnameId: string,
    generation: number,
    from: HostnameState | null,
    to: HostnameState,
    actor: Actor,
    reason: string | null,
    at: number
  ) {
    // Time spent in the state being left. For pending to verified, that is the time to
    // verify since the hostname was added or retried.
    const previous = this.sql
      .exec<{ at: number }>(
        "SELECT at FROM events WHERE hostname_id = ? ORDER BY id DESC LIMIT 1",
        hostnameId
      )
      .toArray()[0];
    this.pendingTransitions.push({
      hostname_id: hostnameId,
      from_state: from,
      to_state: to,
      actor,
      outcome: "committed",
      latency_ms: previous ? Math.max(0, at - previous.at) : 0
    });
    this.sql.exec(
      "INSERT INTO events (hostname_id, generation, from_state, to_state, actor, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      hostnameId,
      generation,
      from,
      to,
      actor,
      reason,
      at
    );
  }

  private sweepIdempotency() {
    this.sql.exec(
      "DELETE FROM idempotency_keys WHERE created_at < ?",
      this.deps.now() - LIMITS.idempotency.ttlSeconds * 1000
    );
  }
}
