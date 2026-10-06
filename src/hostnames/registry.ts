// One HostnameRegistry per normalized hostname. It hands out generations and holds the
// single verified claim. First verified claim wins.
import { DurableObject } from "cloudflare:workers";

export type Owner = { tenant: string; generation: number } | null;
export type ClaimResult = { granted: true } | { granted: false; owner: Owner };

type OwnershipRow = {
  next_generation: number;
  owner_tenant: string | null;
  owner_generation: number | null;
};

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

  private read(): OwnershipRow {
    const sql = this.ctx.storage.sql;
    sql.exec(
      "INSERT OR IGNORE INTO ownership (id, next_generation, updated_at) VALUES (1, 1, ?)",
      Date.now()
    );
    return sql
      .exec<OwnershipRow>(
        "SELECT next_generation, owner_tenant, owner_generation FROM ownership WHERE id = 1"
      )
      .one();
  }

  // Returns a fresh generation for this hostname. Monotonic and never reused.
  register(): number {
    return this.ctx.storage.transactionSync(() => {
      const { next_generation } = this.read();
      this.ctx.storage.sql.exec(
        "UPDATE ownership SET next_generation = ?, updated_at = ? WHERE id = 1",
        next_generation + 1,
        Date.now()
      );
      return next_generation;
    });
  }

  // Granted when nobody owns the hostname, or when the caller already does. A claim the
  // same tenant holds for an older generation is dead (a tenant has at most one live row
  // per hostname), so it is replaced. Another tenant's claim means conflict.
  claim(tenant: string, generation: number): ClaimResult {
    return this.ctx.storage.transactionSync(() => {
      const row = this.read();
      const free = row.owner_tenant === null;
      const mine =
        row.owner_tenant === tenant && row.owner_generation === generation;
      const myStale =
        row.owner_tenant === tenant && (row.owner_generation ?? 0) < generation;
      if (!free && !mine && !myStale) {
        return {
          granted: false as const,
          owner: {
            tenant: row.owner_tenant ?? "",
            generation: row.owner_generation ?? 0
          }
        };
      }
      this.ctx.storage.sql.exec(
        "UPDATE ownership SET owner_tenant = ?, owner_generation = ?, updated_at = ? WHERE id = 1",
        tenant,
        generation,
        Date.now()
      );
      return { granted: true as const };
    });
  }

  // Clears the claim only if it matches. Returns whether the hostname is now not held
  // by this tenant and generation, so callers can treat a repeat as success.
  release(tenant: string, generation: number): boolean {
    return this.ctx.storage.transactionSync(() => {
      this.read();
      this.ctx.storage.sql.exec(
        "UPDATE ownership SET owner_tenant = NULL, owner_generation = NULL, updated_at = ? WHERE id = 1 AND owner_tenant = ? AND owner_generation = ?",
        Date.now(),
        tenant,
        generation
      );
      return true;
    });
  }

  owner(): Owner {
    const row = this.ctx.storage.transactionSync(() => this.read());
    return row.owner_tenant === null
      ? null
      : { tenant: row.owner_tenant, generation: row.owner_generation ?? 0 };
  }
}
