import type { DnsCache, LookupResult, RecordType } from "./doh";

// dns_cache table in the visitor's TenantAgent SQLite.
export class SqlDnsCache implements DnsCache {
  constructor(private readonly sql: SqlStorage) {}

  get(name: string, type: RecordType, nowMs: number): LookupResult | null {
    const row = this.sql
      .exec<{ answer_json: string; expires_at: number }>(
        "SELECT answer_json, expires_at FROM dns_cache WHERE name = ? AND rrtype = ?",
        name,
        type
      )
      .toArray()[0];
    if (!row || row.expires_at <= nowMs) return null;
    return JSON.parse(row.answer_json) as LookupResult;
  }

  set(
    name: string,
    type: RecordType,
    result: LookupResult,
    expiresAtMs: number,
    nowMs: number
  ) {
    this.sql.exec("DELETE FROM dns_cache WHERE expires_at <= ?", nowMs);
    this.sql.exec(
      `INSERT INTO dns_cache (name, rrtype, answer_json, fetched_at, expires_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (name, rrtype) DO UPDATE SET answer_json = excluded.answer_json,
         fetched_at = excluded.fetched_at, expires_at = excluded.expires_at`,
      name,
      type,
      JSON.stringify(result),
      nowMs,
      expiresAtMs
    );
  }
}

export class MemoryDnsCache implements DnsCache {
  private entries = new Map<
    string,
    { result: LookupResult; expiresAt: number }
  >();

  get(name: string, type: RecordType, nowMs: number): LookupResult | null {
    const entry = this.entries.get(`${type} ${name}`);
    return entry && entry.expiresAt > nowMs ? entry.result : null;
  }

  set(
    name: string,
    type: RecordType,
    result: LookupResult,
    expiresAtMs: number
  ) {
    this.entries.set(`${type} ${name}`, { result, expiresAt: expiresAtMs });
  }

  expiryOf(name: string, type: RecordType): number | null {
    return this.entries.get(`${type} ${name}`)?.expiresAt ?? null;
  }
}
