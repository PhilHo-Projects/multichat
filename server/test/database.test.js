import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase } from "../src/database.js";

function tableNames(connection) {
  return connection
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name);
}

test("openDatabase creates every table the app needs", () => {
  const database = openDatabase(":memory:");
  const names = tableNames(database.connection);

  for (const expected of [
    "user",
    "session",
    "account",
    "verification",
    "rateLimit",
    "usage_events",
    "guest_usage",
    "daily_budget",
    "schema_migrations",
  ]) {
    assert.ok(names.includes(expected), `missing table: ${expected}`);
  }

  database.close();
});

test("the account table carries the issuer column Better Auth 1.7 requires", () => {
  const database = openDatabase(":memory:");
  const columns = database.connection
    .prepare(`SELECT name FROM pragma_table_info('account')`)
    .all()
    .map((row) => row.name);

  assert.ok(columns.includes("issuer"));
  database.close();
});

test("migrations are recorded once and re-running them is a no-op", () => {
  const database = openDatabase(":memory:");
  const before = database.connection
    .prepare("SELECT version FROM schema_migrations ORDER BY version")
    .all()
    .map((row) => row.version);

  // Re-running the runner against the same connection must change nothing.
  database.migrate();

  const after = database.connection
    .prepare("SELECT version FROM schema_migrations ORDER BY version")
    .all()
    .map((row) => row.version);

  assert.deepEqual(after, before);
  assert.deepEqual(before, [1, 2]);
  database.close();
});

test("transaction rolls back every statement when the callback throws", () => {
  const database = openDatabase(":memory:");

  assert.throws(() => {
    database.transaction(() => {
      database.connection
        .prepare(
          `INSERT INTO guest_usage (guest_id, ip_hash, messages_used, first_seen, last_seen)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run("g1", "hash", 1, "2026-08-31", "2026-08-31");
      throw new Error("boom");
    });
  }, /boom/);

  const count = database.connection
    .prepare("SELECT COUNT(*) AS count FROM guest_usage")
    .get().count;

  assert.equal(count, 0);
  database.close();
});
