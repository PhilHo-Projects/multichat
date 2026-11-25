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

test("the account table has no issuer column, which Better Auth 1.7.3+ never writes", () => {
  const database = openDatabase(":memory:");
  const columns = database.connection
    .prepare(`SELECT name FROM pragma_table_info('account')`)
    .all()
    .map((row) => row.name);

  assert.ok(!columns.includes("issuer"));
  database.close();
});

test("migration 3 keeps existing accounts when it drops issuer", () => {
  const database = openDatabase(":memory:");
  // Put the database back in its version 2 shape: issuer present and indexed.
  database.connection.exec(`
    ALTER TABLE "account" ADD COLUMN "issuer" text;
    CREATE UNIQUE INDEX "account_issuer_accountId_uidx" ON "account" ("issuer", "accountId");
    DELETE FROM schema_migrations WHERE version = 3;
    INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt", "role", "approvalStatus")
      VALUES ('user-1', 'Phil', 'phil@example.test', 1, '2026-08-17', '2026-08-17', 'owner', 'approved');
    INSERT INTO "account" ("id", "issuer", "accountId", "providerId", "userId", "password", "createdAt", "updatedAt")
      VALUES ('account-1', 'local:credential', 'user-1', 'credential', 'user-1', 'hash', '2026-08-17', '2026-08-17');
  `);

  database.migrate();

  const columns = database.connection
    .prepare(`SELECT name FROM pragma_table_info('account')`)
    .all()
    .map((row) => row.name);
  assert.ok(!columns.includes("issuer"));
  assert.deepEqual(
    { ...database.connection.prepare(`SELECT "providerId", "password" FROM "account" WHERE "id" = ?`).get("account-1") },
    { providerId: "credential", password: "hash" },
  );
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
  assert.deepEqual(before, [1, 2, 3]);
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
