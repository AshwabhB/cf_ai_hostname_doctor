// Verification lifecycle for one visitor: starting runs, the workflow's callbacks,
// deletes, and reconcile (DESIGN.md section 6). TenantAgent wires it to the real
// workflow binding and registry. Tests wire it to fakes.
import { LIMITS } from "../config/limits";
import type { Diagnosis } from "../dns/diagnose";
import type { VerifyParams } from "../workflow/verify";
import type { DiagnosisService } from "./diagnosis";
import type { ClaimResult, Owner } from "./registry";
import type {
  CertificateView,
  HostnameService,
  HostnameView,
  Result,
  WorkflowRow
} from "./service";

export type RegistryClient = {
  claim(tenant: string, generation: number): Promise<ClaimResult>;
  release(tenant: string, generation: number): Promise<boolean>;
  owner(): Promise<Owner>;
};

export type WorkflowStatus =
  | "queued"
  | "running"
  | "paused"
  | "errored"
  | "terminated"
  | "complete"
  | "waiting"
  | "waitingForPause"
  | "rollingBack"
  | "unknown"
  | "missing";

export type LifecycleDeps = {
  tenantId: string;
  hostnames: HostnameService;
  diagnoses: DiagnosisService;
  registry(hostname: string): RegistryClient;
  // Starts an instance with this exact id. A duplicate id must not create a second one.
  startWorkflow(id: string, params: VerifyParams): Promise<void>;
  // Stops an instance. Already finished or unknown instances are fine.
  terminateWorkflow(id: string): Promise<void>;
  workflowStatus(id: string): Promise<WorkflowStatus>;
  now(): number;
};

const LIVE_WORKFLOW: ReadonlySet<WorkflowStatus> = new Set([
  "queued",
  "running",
  "paused",
  "waiting",
  "waitingForPause",
  "rollingBack"
]);

export type ReconcileReport = {
  restarted: string[];
  // Pending rows whose instance looked live but had stopped making progress.
  stalled: string[];
  // Pending rows whose running instance was found by its id and recorded.
  adopted: string[];
  conflicted: string[];
  released: string[];
  finishedDeletes: string[];
};

export class HostnameLifecycle {
  constructor(private readonly deps: LifecycleDeps) {}

  // Workflows allow only letters, digits, "-" and "_" in ids, up to 100 characters.
  // This is about 70.
  instanceId(row: { id: string; generation: number }, run: number): string {
    return `${this.deps.tenantId}-${row.id}-g${row.generation}-r${run}`;
  }

  // Starts the next run for a pending row. The id is deterministic, so a duplicate start
  // fails instead of creating a second instance. If recording the id fails afterwards,
  // the running instance still finds the row by id and generation.
  async startVerification(hostnameId: string): Promise<string | null> {
    const row = this.deps.hostnames.workflowRow(hostnameId);
    if (!row || row.state !== "pending") return null;
    const run = row.workflow_run + 1;
    const id = this.instanceId(row, run);
    try {
      await this.deps.startWorkflow(id, {
        tenantId: this.deps.tenantId,
        hostnameId: row.id,
        hostname: row.hostname,
        generation: row.generation,
        run
      });
    } catch {
      // Left pending without a live instance. Reconcile starts it again.
      return null;
    }
    this.deps.hostnames.setWorkflow(row.id, row.generation, id, run);
    return id;
  }

  // ---- Callbacks from VerifyWorkflow. Each is fenced by generation. ----

  load(
    hostnameId: string,
    generation: number
  ): { hostname: string; token: string } | null {
    const row = this.deps.hostnames.workflowRow(hostnameId);
    if (!row || row.generation !== generation || row.state !== "pending")
      return null;
    return { hostname: row.hostname, token: row.verify_token };
  }

  record(
    hostnameId: string,
    generation: number,
    diagnosis: Diagnosis & { checkedAt: number }
  ): { live: boolean } {
    const saved = this.deps.diagnoses.save(
      hostnameId,
      generation,
      diagnosis,
      diagnosis.checkedAt
    );
    const row = this.deps.hostnames.workflowRow(hostnameId);
    return { live: saved.ok && row?.state === "pending" };
  }

  // A workflow step may run more than once. Being in the target state already, on the
  // same generation, counts as success, so a repeated step changes nothing.
  private already(
    hostnameId: string,
    generation: number,
    targets: readonly string[]
  ): Result<{ hostname: HostnameView }> | null {
    const row = this.deps.hostnames.workflowRow(hostnameId);
    if (!row || row.generation !== generation || !targets.includes(row.state))
      return null;
    return this.deps.hostnames.get(hostnameId);
  }

  giveUp(
    hostnameId: string,
    generation: number
  ): Result<{ hostname: HostnameView }> {
    const done = this.already(hostnameId, generation, ["failed"]);
    if (done) return done;
    return this.deps.hostnames.systemTransition(
      hostnameId,
      generation,
      ["pending"],
      "failed",
      "verification gave up after 24 hours"
    );
  }

  settle(
    hostnameId: string,
    generation: number,
    granted: boolean
  ): Result<{ hostname: HostnameView }> {
    const done = this.already(
      hostnameId,
      generation,
      granted ? ["verified", "active"] : ["conflict"]
    );
    if (done) return done;
    return this.deps.hostnames.systemTransition(
      hostnameId,
      generation,
      ["pending"],
      granted ? "verified" : "conflict",
      granted
        ? "TXT verified and registry claim granted"
        : "another visitor holds this hostname"
    );
  }

  activate(
    hostnameId: string,
    generation: number,
    issuedAtMs: number
  ): Result<{ hostname: HostnameView }> {
    const done = this.already(hostnameId, generation, ["active"]);
    if (done) return done;
    const certificate: CertificateView = {
      simulated: true,
      issuer: "Simulated",
      issued_at: new Date(issuedAtMs).toISOString(),
      not_after: new Date(
        issuedAtMs + LIMITS.verify.certificateDays * 24 * 60 * 60 * 1000
      ).toISOString()
    };
    return this.deps.hostnames.systemTransition(
      hostnameId,
      generation,
      ["verified"],
      "active",
      "simulated certificate issued",
      { certificate }
    );
  }

  // ---- Delete ----

  async delete(
    hostnameId: string,
    etag: string
  ): Promise<Result<{ hostname: HostnameView }>> {
    const begun = this.deps.hostnames.beginDelete(hostnameId, etag, "user");
    if (!begun.ok) return begun;
    const finished = await this.finishDeletion(hostnameId);
    return finished ?? begun;
  }

  // Stops the workflow (ignoring an unknown or finished instance), releases the claim,
  // then marks the row deleted. Any failure leaves it deleting for reconcile.
  async finishDeletion(
    hostnameId: string
  ): Promise<Result<{ hostname: HostnameView }> | null> {
    const row = this.deps.hostnames.workflowRow(hostnameId);
    if (!row || row.state !== "deleting") return null;
    if (row.workflow_instance_id) {
      const status = await this.deps.workflowStatus(row.workflow_instance_id);
      if (LIVE_WORKFLOW.has(status)) {
        try {
          await this.deps.terminateWorkflow(row.workflow_instance_id);
        } catch {
          // Finished in the meantime. Either way it no longer runs.
        }
      }
    }
    try {
      await this.deps
        .registry(row.hostname)
        .release(this.deps.tenantId, row.generation);
    } catch {
      return null;
    }
    return this.deps.hostnames.finishDelete(
      row.id,
      row.generation,
      "workflow stopped and registry claim released"
    );
  }

  // ---- Reconcile (DESIGN.md section 6 table) ----

  async reconcile(): Promise<ReconcileReport> {
    const report: ReconcileReport = {
      restarted: [],
      stalled: [],
      adopted: [],
      conflicted: [],
      released: [],
      finishedDeletes: []
    };
    for (const row of this.deps.hostnames.reconcileRows()) {
      try {
        await this.reconcileRow(row, report);
      } catch {
        // One row failing must not stop the rest. The next pass tries again.
      }
    }
    return report;
  }

  private isStalled(row: WorkflowRow): boolean {
    const heartbeat = Math.max(
      row.last_checked_at ?? 0,
      row.workflow_started_at ?? 0
    );
    return this.deps.now() - heartbeat > LIMITS.verify.stalledAfterMs;
  }

  private async reconcileRow(row: WorkflowRow, report: ReconcileReport) {
    switch (row.state) {
      case "pending": {
        // No recorded id: an instance may have started while recording its id failed.
        // The id is deterministic, so look for it before starting another run.
        if (row.workflow_instance_id === null) {
          const nextId = this.instanceId(row, row.workflow_run + 1);
          if (LIVE_WORKFLOW.has(await this.deps.workflowStatus(nextId))) {
            this.deps.hostnames.setWorkflow(
              row.id,
              row.generation,
              nextId,
              row.workflow_run + 1
            );
            report.adopted.push(row.id);
            return;
          }
        }
        // Pending with no live instance: start the next run.
        const status = row.workflow_instance_id
          ? await this.deps.workflowStatus(row.workflow_instance_id)
          : "missing";
        let live = LIVE_WORKFLOW.has(status);
        // An engine can report an instance as waiting or running after losing its wake-up
        // (a local runtime restart did exactly this). Our own heartbeat decides instead:
        // no recorded attempt and no run start for too long means the run is stalled.
        if (live && row.workflow_instance_id && this.isStalled(row)) {
          try {
            await this.deps.terminateWorkflow(row.workflow_instance_id);
          } catch {
            // It may already be gone. The next run starts either way.
          }
          report.stalled.push(row.id);
          live = false;
        }
        if (!live && (await this.startVerification(row.id))) {
          report.restarted.push(row.id);
        }
        return;
      }
      case "verified":
      case "active": {
        // Verified or active, but the registry says someone else owns it.
        const owner = await this.deps.registry(row.hostname).owner();
        const mine =
          owner?.tenant === this.deps.tenantId &&
          owner.generation === row.generation;
        if (!mine) {
          const moved = this.deps.hostnames.systemTransition(
            row.id,
            row.generation,
            ["verified", "active"],
            "conflict",
            "registry claim held by another visitor"
          );
          if (moved.ok) report.conflicted.push(row.id);
        }
        return;
      }
      case "deleting": {
        // Stuck deleting: finish the delete.
        if (this.deps.now() - row.updated_at >= LIMITS.verify.deletingStuckMs) {
          if (await this.finishDeletion(row.id))
            report.finishedDeletes.push(row.id);
        }
        return;
      }
      case "deleted": {
        // A claim left behind by a deleted row: release it if it is still ours.
        const owner = await this.deps.registry(row.hostname).owner();
        if (
          owner?.tenant === this.deps.tenantId &&
          owner.generation === row.generation
        ) {
          await this.deps
            .registry(row.hostname)
            .release(this.deps.tenantId, row.generation);
          report.released.push(row.id);
        }
        this.deps.hostnames.markReleased(row.id, row.generation);
        return;
      }
      default:
        return;
    }
  }
}
