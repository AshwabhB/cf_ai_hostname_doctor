// Saved DNS diagnoses. Kept apart from the hostname row's version, so the hostname ETag
// changes only on real transitions. A check never changes state; that is the workflow's job.
import { LIMITS } from "../config/limits";
import type { Diagnosis } from "../dns/diagnose";
import type { Finding } from "../dns/rules";
import type { HostnameState } from "./state-machine";
import type { Result } from "./service";

const ID_PATTERN = /^hn_[0-9a-f]{24}$/;
const HOUR_MS = 60 * 60 * 1000;

export type DiagnosisView = {
  hostname_id: string;
  generation: number;
  checked_at: string | null;
  verifiable: boolean | null;
  findings: Finding[];
  etag: string;
};

type Row = {
  id: string;
  hostname: string;
  generation: number;
  state: HostnameState;
  verify_token: string;
  findings_json: string | null;
  last_checked_at: number | null;
};

export type DiagnosisDeps = {
  diagnose(input: { hostname: string; token: string }): Promise<Diagnosis>;
  now(): number;
};

export function diagnosisEtag(id: string, checkedAt: number | null): string {
  return `"${id}.diag.${checkedAt ?? 0}"`;
}

function toView(row: Row): DiagnosisView {
  const saved = row.findings_json
    ? (JSON.parse(row.findings_json) as {
        verifiable: boolean;
        findings: Finding[];
      })
    : null;
  return {
    hostname_id: row.id,
    generation: row.generation,
    checked_at:
      row.last_checked_at === null
        ? null
        : new Date(row.last_checked_at).toISOString(),
    verifiable: saved?.verifiable ?? null,
    findings: saved?.findings ?? [],
    etag: diagnosisEtag(row.id, row.last_checked_at)
  };
}

export class DiagnosisService {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly deps: DiagnosisDeps
  ) {}

  private row(id: string): Row | null {
    if (!ID_PATTERN.test(id)) return null;
    return (
      this.storage.sql
        .exec<Row>(
          "SELECT id, hostname, generation, state, verify_token, findings_json, last_checked_at FROM hostnames WHERE id = ?",
          id
        )
        .toArray()[0] ?? null
    );
  }

  get(id: string): Result<{ diagnosis: DiagnosisView }> {
    const row = this.row(id);
    return row
      ? { ok: true, diagnosis: toView(row) }
      : { ok: false, error: "not-found" };
  }

  // Counts this check against the hourly limit, then runs it. Returns false when over.
  private takeCheckSlot(now: number): boolean {
    const sql = this.storage.sql;
    return this.storage.transactionSync(() => {
      sql.exec("DELETE FROM check_runs WHERE at <= ?", now - HOUR_MS);
      const used = sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM check_runs")
        .one().n;
      if (used >= LIMITS.checks.perVisitorPerHour) return false;
      sql.exec("INSERT INTO check_runs (at) VALUES (?)", now);
      return true;
    });
  }

  // Saves a diagnosis onto the same live generation. Used by the workflow, which has its
  // own schedule and does not spend the visitor's hourly check budget.
  save(
    id: string,
    generation: number,
    result: Diagnosis,
    checkedAtMs: number
  ): Result<{ diagnosis: DiagnosisView }> {
    return this.storage.transactionSync(() => {
      const current = this.row(id);
      if (!current || current.generation !== generation) {
        return { ok: false as const, error: "not-found" as const };
      }
      if (current.state === "deleting" || current.state === "deleted") {
        return { ok: false as const, error: "invalid-transition" as const };
      }
      const checkedAt = Math.max(
        checkedAtMs,
        (current.last_checked_at ?? 0) + 1
      );
      const findingsJson = JSON.stringify({
        verifiable: result.verifiable,
        findings: result.findings
      });
      this.storage.sql.exec(
        "UPDATE hostnames SET findings_json = ?, last_checked_at = ? WHERE id = ? AND generation = ?",
        findingsJson,
        checkedAt,
        id,
        generation
      );
      return {
        ok: true as const,
        diagnosis: toView({
          ...current,
          findings_json: findingsJson,
          last_checked_at: checkedAt
        })
      };
    });
  }

  async check(id: string): Promise<Result<{ diagnosis: DiagnosisView }>> {
    const row = this.row(id);
    if (!row) return { ok: false, error: "not-found" };
    if (row.state === "deleting" || row.state === "deleted") {
      return { ok: false, error: "invalid-transition" };
    }
    if (!this.takeCheckSlot(this.deps.now()))
      return { ok: false, error: "rate-limited" };

    const result = await this.deps.diagnose({
      hostname: row.hostname,
      token: row.verify_token
    });

    // The row may have been deleted while DNS was in flight. save() only writes onto
    // the same, still-live generation.
    return this.save(id, row.generation, result, this.deps.now());
  }
}
