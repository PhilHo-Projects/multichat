import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  checkBudget,
  effectiveBudget,
  monthStartISO,
  recordUsage,
  summarizeUserBudget,
} from "../src/budget.js";
import { loadAuthConfig } from "../src/config.js";
import { openDatabase } from "../src/database.js";

function setup(overrides = {}) {
  const config = loadAuthConfig({
    NODE_ENV: "test",
    PUBLIC_ORIGIN: "https://chat.philippeho.dev",
    SESSION_SECRET: "0".repeat(64),
    OWNER_EMAIL: "phil@example.com",
    OWNER_PASSWORD: "owner-password-long",
    ...overrides,
  });
  const database = openDatabase(":memory:");

  database.connection
    .prepare(
      `INSERT INTO "user" ("id","name","email","emailVerified","createdAt","updatedAt",
                           "username","role","approvalStatus")
       VALUES (?,?,?,0,?,?,?,?,'approved')`
    )
    .run(
      "u1",
      "alice",
      "alice@example.com",
      "2026-08-01",
      "2026-08-01",
      "alice",
      "member"
    );

  return { config, database };
}

function insertUsage(database, { userId, tokens, createdAt }) {
  database.connection
    .prepare(
      `INSERT INTO usage_events
         (id, user_id, guest_id, provider, model_id, prompt_tokens, completion_tokens, total_tokens, created_at)
       VALUES (?, ?, NULL, 'google', 'gemini-2.5-flash', 0, ?, ?, ?)`
    )
    .run(randomUUID(), userId, tokens, tokens, createdAt);
}

test("effectiveBudget prefers the per-user override over the default", () => {
  const { config } = setup({ DEFAULT_MONTHLY_TOKEN_BUDGET: "1000" });

  assert.equal(effectiveBudget({ monthlyTokenBudget: null }, config), 1000);
  assert.equal(effectiveBudget({ monthlyTokenBudget: 25 }, config), 25);
});

test("usage from a previous month does not count against this month", () => {
  const { config, database } = setup({ DEFAULT_MONTHLY_TOKEN_BUDGET: "100" });
  const user = { id: "u1", role: "member", monthlyTokenBudget: null };

  insertUsage(database, {
    userId: "u1",
    tokens: 500,
    createdAt: "2026-07-15T00:00:00.000Z",
  });

  const summary = summarizeUserBudget({ database, config, user });
  assert.equal(summary.tokensUsed, 0);
  assert.deepEqual(checkBudget({ database, config, user }), { ok: true });

  database.close();
});

test("a user at their cap is refused with scope 'user'", () => {
  const { config, database } = setup({ DEFAULT_MONTHLY_TOKEN_BUDGET: "100" });
  const user = { id: "u1", role: "member", monthlyTokenBudget: null };

  insertUsage(database, {
    userId: "u1",
    tokens: 100,
    createdAt: new Date().toISOString(),
  });

  assert.deepEqual(checkBudget({ database, config, user }), { ok: false, scope: "user" });
  database.close();
});

test("the owner is exempt from the per-user cap but not from the global ceiling", () => {
  const { config, database } = setup({
    DEFAULT_MONTHLY_TOKEN_BUDGET: "10",
    GLOBAL_DAILY_TOKEN_LIMIT: "50",
  });
  const owner = { id: "u1", role: "owner", monthlyTokenBudget: null };

  insertUsage(database, {
    userId: "u1",
    tokens: 1000,
    createdAt: new Date().toISOString(),
  });
  assert.deepEqual(checkBudget({ database, config, user: owner }), { ok: true });

  database.connection
    .prepare(
      `INSERT INTO daily_budget (date, guest_messages, tokens) VALUES (?, 0, 60)
       ON CONFLICT(date) DO UPDATE SET tokens = 60`
    )
    .run(new Date().toISOString().slice(0, 10));

  assert.deepEqual(checkBudget({ database, config, user: owner }), {
    ok: false,
    scope: "global",
  });

  database.close();
});

test("recordUsage writes one event and moves the daily total", () => {
  const { config, database } = setup();
  const user = { id: "u1", role: "member", monthlyTokenBudget: null };

  recordUsage({
    database,
    user,
    guest: null,
    provider: "nvidia",
    modelId: "deepseek-ai/deepseek-v4-pro",
    usage: { promptTokenCount: 12, candidatesTokenCount: 30, totalTokenCount: 42 },
  });

  const event = database.connection.prepare("SELECT * FROM usage_events").get();
  assert.equal(event.user_id, "u1");
  assert.equal(event.total_tokens, 42);
  assert.equal(event.provider, "nvidia");

  const daily = database.connection
    .prepare("SELECT tokens FROM daily_budget WHERE date = ?")
    .get(new Date().toISOString().slice(0, 10)).tokens;
  assert.equal(daily, 42);

  assert.equal(summarizeUserBudget({ database, config, user }).tokensUsed, 42);
  database.close();
});

test("recordUsage is a no-op when the stream reported no usage", () => {
  const { database } = setup();

  recordUsage({
    database,
    user: { id: "u1", role: "member" },
    guest: null,
    provider: "google",
    modelId: "gemini-2.5-flash",
    usage: null,
  });

  const count = database.connection
    .prepare("SELECT COUNT(*) AS count FROM usage_events")
    .get().count;
  assert.equal(count, 0);
  database.close();
});

test("a guest's usage is recorded against the guest, not a user", () => {
  const { database } = setup();

  recordUsage({
    database,
    user: null,
    guest: { guestId: "g1", ipHash: "ip1" },
    provider: "google",
    modelId: "gemini-2.5-flash",
    usage: { promptTokenCount: 5, candidatesTokenCount: 7, totalTokenCount: 12 },
  });

  const event = database.connection.prepare("SELECT * FROM usage_events").get();
  assert.equal(event.user_id, null);
  assert.equal(event.guest_id, "g1");
  assert.equal(event.total_tokens, 12);
  database.close();
});

test("monthStartISO returns the first instant of the current UTC month", () => {
  assert.equal(
    monthStartISO(new Date("2026-08-31T23:59:59.000Z")),
    "2026-08-01T00:00:00.000Z"
  );
});
