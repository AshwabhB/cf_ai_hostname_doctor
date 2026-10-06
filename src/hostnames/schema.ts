// Forward-only migrations for TenantAgent's SQLite. Applied in order, each in its own
// transaction, and recorded in hd_schema_migrations. Never edit a shipped migration.

const MIGRATIONS: readonly string[][] = [
  // 1: tables and indexes from DESIGN.md section 4.
  [
    `CREATE TABLE hostnames (
      id TEXT PRIMARY KEY,
      hostname TEXT NOT NULL,
      generation INTEGER NOT NULL,
      state TEXT NOT NULL,
      version INTEGER NOT NULL,
      verify_token TEXT NOT NULL,
      findings_json TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      workflow_instance_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_checked_at INTEGER
    )`,
    // create: one live row per hostname
    `CREATE UNIQUE INDEX hostnames_live_hostname ON hostnames (hostname) WHERE state <> 'deleted'`,
    // list: cursor paging, newest first
    `CREATE INDEX hostnames_created ON hostnames (created_at, id)`,
    // reconcile: stale pending or deleting rows
    `CREATE INDEX hostnames_state_checked ON hostnames (state, last_checked_at)`,
    `CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hostname_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      from_state TEXT,
      to_state TEXT NOT NULL,
      actor TEXT NOT NULL,
      reason TEXT,
      at INTEGER NOT NULL
    )`,
    // timeline for one hostname
    `CREATE INDEX events_hostname ON events (hostname_id, id)`,
    `CREATE TABLE idempotency_keys (
      key TEXT PRIMARY KEY,
      request_hash TEXT NOT NULL,
      status INTEGER NOT NULL,
      response_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    // sweep keys past the TTL, evict the oldest past the row cap
    `CREATE INDEX idempotency_created ON idempotency_keys (created_at)`,
    `CREATE TABLE dns_cache (
      name TEXT NOT NULL,
      rrtype TEXT NOT NULL,
      answer_json TEXT NOT NULL,
      fetched_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      PRIMARY KEY (name, rrtype)
    )`,
    // evict expired answers
    `CREATE INDEX dns_cache_expires ON dns_cache (expires_at)`
  ],
  // 2: manual DNS checks, for the per-visitor hourly limit.
  [
    `CREATE TABLE check_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL)`,
    // count and prune runs in the last hour
    `CREATE INDEX check_runs_at ON check_runs (at)`
  ],
  // 3: the one-turn-per-visitor chat lease.
  [
    `CREATE TABLE turn_lease (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      holder TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )`
  ]
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function migrate(storage: DurableObjectStorage): number {
  const sql = storage.sql;
  sql.exec(
    "CREATE TABLE IF NOT EXISTS hd_schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)"
  );
  const current =
    sql
      .exec<{ v: number | null }>(
        "SELECT MAX(version) AS v FROM hd_schema_migrations"
      )
      .one().v ?? 0;
  for (let version = current + 1; version <= MIGRATIONS.length; version++) {
    storage.transactionSync(() => {
      for (const statement of MIGRATIONS[version - 1]) sql.exec(statement);
      sql.exec(
        "INSERT INTO hd_schema_migrations (version, applied_at) VALUES (?, ?)",
        version,
        Date.now()
      );
    });
  }
  return MIGRATIONS.length;
}
