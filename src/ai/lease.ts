// One chat turn per visitor. The lease lives in DO SQLite so it survives hibernation.
// It is released when the turn ends (completed, error, abort, timeout or skipped). The
// expiry is only a backstop for a turn that never reports back.
import { LIMITS } from "../config/limits";

export class TurnLease {
  constructor(private readonly storage: DurableObjectStorage) {}

  acquire(holder: string, nowMs: number): boolean {
    const sql = this.storage.sql;
    return this.storage.transactionSync(() => {
      const current = sql
        .exec<{ holder: string; expires_at: number }>(
          "SELECT holder, expires_at FROM turn_lease WHERE id = 1"
        )
        .toArray()[0];
      if (current && current.expires_at > nowMs && current.holder !== holder)
        return false;
      sql.exec(
        `INSERT INTO turn_lease (id, holder, expires_at) VALUES (1, ?, ?)
         ON CONFLICT (id) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at`,
        holder,
        nowMs + LIMITS.chat.leaseMs
      );
      return true;
    });
  }

  // Only the holder can release, so a late release never frees someone else's turn.
  release(holder: string): void {
    this.storage.sql.exec(
      "DELETE FROM turn_lease WHERE id = 1 AND holder = ?",
      holder
    );
  }

  holder(nowMs: number): string | null {
    const row = this.storage.sql
      .exec<{ holder: string; expires_at: number }>(
        "SELECT holder, expires_at FROM turn_lease WHERE id = 1"
      )
      .toArray()[0];
    return row && row.expires_at > nowMs ? row.holder : null;
  }
}
