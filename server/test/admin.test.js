import assert from "node:assert/strict";
import test from "node:test";

import { listUsers, setApprovalStatus, setUserBudget } from "../src/admin.js";
import { loadAuthConfig } from "../src/config.js";
import { openDatabase } from "../src/database.js";

function setup() {
  const config = loadAuthConfig({
    NODE_ENV: "test",
    PUBLIC_ORIGIN: "https://chat.philippeho.dev",
    SESSION_SECRET: "0".repeat(64),
    OWNER_EMAIL: "phil@example.com",
    OWNER_PASSWORD: "owner-password-long",
  });
  const database = openDatabase(":memory:");

  const insert = database.connection.prepare(
    `INSERT INTO "user" ("id","name","email","emailVerified","createdAt","updatedAt",
                         "username","role","approvalStatus")
     VALUES (?,?,?,0,?,?,?,?,?)`
  );
  insert.run(
    "owner1",
    "phil",
    "phil@example.com",
    "2026-08-01",
    "2026-08-01",
    "phil",
    "owner",
    "approved"
  );
  insert.run(
    "u1",
    "alice",
    "alice@example.com",
    "2026-08-02",
    "2026-08-02",
    "alice",
    "member",
    "pending"
  );

  return { config, database };
}

test("listUsers defaults to pending only and never selects unlisted columns", () => {
  const { database, config } = setup();
  const users = listUsers({ database, config, status: "pending" });

  assert.equal(users.length, 1);
  assert.equal(users[0].username, "alice");
  assert.equal(users[0].password, undefined, "never SELECT *");
  assert.equal(typeof users[0].tokensUsed, "number");

  assert.equal(listUsers({ database, config, status: "all" }).length, 2);
  database.close();
});

test("approving records who approved and when", () => {
  const { database } = setup();

  const result = setApprovalStatus({
    database,
    id: "u1",
    status: "approved",
    actorId: "owner1",
  });

  assert.deepEqual(result, { ok: true, id: "u1", approvalStatus: "approved" });

  const row = database.connection
    .prepare(`SELECT "approvalStatus","approvedBy","approvedAt" FROM "user" WHERE "id" = ?`)
    .get("u1");

  assert.equal(row.approvalStatus, "approved");
  assert.equal(row.approvedBy, "owner1");
  assert.ok(row.approvedAt);
  database.close();
});

test("rejecting kills the user's live sessions immediately", () => {
  const { database } = setup();

  database.connection
    .prepare(
      `INSERT INTO session ("id","expiresAt","token","createdAt","updatedAt","userId")
       VALUES (?,?,?,?,?,?)`
    )
    .run("s1", "2026-12-01", "token-1", "2026-08-02", "2026-08-02", "u1");

  setApprovalStatus({ database, id: "u1", status: "rejected", actorId: "owner1" });

  const sessions = database.connection
    .prepare('SELECT COUNT(*) AS count FROM session WHERE "userId" = ?')
    .get("u1").count;

  assert.equal(sessions, 0, "revocation is the whole point of server-side sessions");
  database.close();
});

test("the owner cannot be rejected", () => {
  const { database } = setup();

  const result = setApprovalStatus({
    database,
    id: "owner1",
    status: "rejected",
    actorId: "owner1",
  });

  assert.deepEqual(result, { ok: false, code: "CONFLICT" });
  database.close();
});

test("a missing user is reported, not silently ignored", () => {
  const { database } = setup();

  assert.deepEqual(
    setApprovalStatus({ database, id: "nope", status: "approved", actorId: "owner1" }),
    { ok: false, code: "NOT_FOUND" }
  );
  database.close();
});

test("setUserBudget sets an override and clears it with null", () => {
  const { database } = setup();

  setUserBudget({ database, id: "u1", monthlyTokenBudget: 1234 });
  assert.equal(
    database.connection
      .prepare(`SELECT "monthlyTokenBudget" AS budget FROM "user" WHERE "id" = ?`)
      .get("u1").budget,
    1234
  );

  setUserBudget({ database, id: "u1", monthlyTokenBudget: null });
  assert.equal(
    database.connection
      .prepare(`SELECT "monthlyTokenBudget" AS budget FROM "user" WHERE "id" = ?`)
      .get("u1").budget,
    null
  );
  database.close();
});
