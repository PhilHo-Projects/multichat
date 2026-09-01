import assert from "node:assert/strict";
import test from "node:test";

import { buildAuth } from "../src/auth.js";
import { loadAuthConfig } from "../src/config.js";
import { openDatabase } from "../src/database.js";
import { ensureOwner } from "../src/owner.js";

function setup() {
  const config = loadAuthConfig({
    NODE_ENV: "test",
    PUBLIC_ORIGIN: "https://chat.philippeho.dev",
    SESSION_SECRET: "0".repeat(64),
    OWNER_EMAIL: "phil@example.com",
    OWNER_PASSWORD: "owner-password-long",
  });
  const database = openDatabase(":memory:");
  const auth = buildAuth({ connection: database.connection, config });
  return { auth, database, config };
}

async function signUpMember(auth, username) {
  return auth.api.signUpEmail({
    body: {
      email: `${username}@example.com`,
      name: username,
      username,
      password: "member-password-long",
    },
  });
}

test("a new account is created pending, as a member, and holds no session", async () => {
  const { auth, database } = setup();

  await signUpMember(auth, "alice");

  const row = database.connection
    .prepare(`SELECT "role", "approvalStatus" FROM "user" WHERE "username" = ?`)
    .get("alice");

  assert.equal(row.role, "member");
  assert.equal(row.approvalStatus, "pending");

  const sessions = database.connection
    .prepare("SELECT COUNT(*) AS count FROM session")
    .get().count;
  assert.equal(sessions, 0, "autoSignIn must be off - sign-up must never mint a session");

  database.close();
});

test("role supplied in a sign-up body is ignored", async () => {
  const { auth, database } = setup();

  await auth.api.signUpEmail({
    body: {
      email: "mallory@example.com",
      name: "mallory",
      username: "mallory",
      password: "member-password-long",
      role: "owner",
      approvalStatus: "approved",
    },
  });

  const row = database.connection
    .prepare(`SELECT "role", "approvalStatus" FROM "user" WHERE "username" = ?`)
    .get("mallory");

  assert.equal(row.role, "member");
  assert.equal(row.approvalStatus, "pending");
  database.close();
});

test("a pending user cannot sign in", async () => {
  const { auth, database } = setup();
  await signUpMember(auth, "bob");

  await assert.rejects(
    () =>
      auth.api.signInUsername({
        body: { username: "bob", password: "member-password-long" },
      }),
    (error) => {
      // Better Auth throws APIError; the approval gate sets this code.
      assert.match(
        JSON.stringify(error.body ?? error.message),
        /ACCOUNT_PENDING/,
        "the gate must refuse for the pending reason, not a generic failure"
      );
      return true;
    }
  );

  const sessions = database.connection
    .prepare("SELECT COUNT(*) AS count FROM session")
    .get().count;
  assert.equal(sessions, 0);
  database.close();
});

test("an approved user can sign in", async () => {
  const { auth, database } = setup();
  await signUpMember(auth, "carol");

  database.connection
    .prepare(`UPDATE "user" SET "approvalStatus" = 'approved' WHERE "username" = ?`)
    .run("carol");

  const result = await auth.api.signInUsername({
    body: { username: "carol", password: "member-password-long" },
  });

  assert.ok(result, "sign-in should resolve for an approved user");

  const sessions = database.connection
    .prepare("SELECT COUNT(*) AS count FROM session")
    .get().count;
  assert.equal(sessions, 1);
  database.close();
});

test("ensureOwner seeds once and is ignored on every boot after", async () => {
  const { auth, database, config } = setup();

  const firstId = await ensureOwner({ auth, connection: database.connection, config });
  const secondId = await ensureOwner({ auth, connection: database.connection, config });

  assert.equal(firstId, secondId);

  const owners = database.connection
    .prepare(`SELECT "role", "approvalStatus" FROM "user" WHERE "role" = 'owner'`)
    .all();

  assert.equal(owners.length, 1);
  assert.equal(owners[0].approvalStatus, "approved");
  database.close();
});
