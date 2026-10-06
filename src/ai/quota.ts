// Daily model turn quota per visitor, kept in TenantAgent's SQLite. One statement takes a
// turn or refuses it, so two sockets of the same visitor can never both get the last one.
import { LIMITS } from "../config/limits";

const DAY_MS = 24 * 60 * 60 * 1000;

export type QuotaResult =
  | { ok: true; used: number }
  | { ok: false; retryAfterSeconds: number };

function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, "YYYY-MM-DD".length);
}

// Seconds until the next UTC midnight, when the count starts again.
export function secondsUntilReset(nowMs: number): number {
  return Math.ceil((DAY_MS - (nowMs % DAY_MS)) / 1000);
}

export class TurnQuota {
  constructor(private readonly storage: DurableObjectStorage) {}

  take(nowMs: number): QuotaResult {
    const day = utcDay(nowMs);
    const sql = this.storage.sql;
    return this.storage.transactionSync(() => {
      // Earlier days are never read again.
      sql.exec("DELETE FROM turn_quota WHERE day <> ?", day);
      // The update is skipped once the limit is reached, so no row comes back.
      const row = sql
        .exec<{ used: number }>(
          `INSERT INTO turn_quota (day, used) VALUES (?, 1)
           ON CONFLICT (day) DO UPDATE SET used = used + 1 WHERE used < ?
           RETURNING used`,
          day,
          LIMITS.chat.turnsPerVisitorPerDay
        )
        .toArray()[0];
      return row
        ? { ok: true, used: row.used }
        : { ok: false, retryAfterSeconds: secondsUntilReset(nowMs) };
    });
  }

  used(nowMs: number): number {
    return (
      this.storage.sql
        .exec<{ used: number }>(
          "SELECT used FROM turn_quota WHERE day = ?",
          utcDay(nowMs)
        )
        .toArray()[0]?.used ?? 0
    );
  }
}
