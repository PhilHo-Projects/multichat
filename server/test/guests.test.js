import assert from "node:assert/strict";
import test from "node:test";

import { loadAuthConfig } from "../src/config.js";
import { openDatabase } from "../src/database.js";
import {
  consumeGuestMessage,
  hashIp,
  isModelAllowedForGuests,
  summarizeGuestAllowance,
} from "../src/guests.js";

function setup(overrides = {}) {
  const config = loadAuthConfig({
    NODE_ENV: "test",
    PUBLIC_ORIGIN: "https://chat.philippeho.dev",
    SESSION_SECRET: "0".repeat(64),
    OWNER_EMAIL: "phil@example.com",
    OWNER_PASSWORD: "owner-password-long",
    ...overrides,
  });
  return { config, database: openDatabase(":memory:") };
}

test("a guest gets exactly GUEST_MESSAGE_LIMIT messages", () => {
  const { config, database } = setup({ GUEST_MESSAGE_LIMIT: "3" });
  const guest = { guestId: "g1", ipHash: "ip1" };

  for (let index = 0; index < 3; index += 1) {
    assert.deepEqual(consumeGuestMessage({ database, config, guest }), { ok: true });
  }

  assert.deepEqual(consumeGuestMessage({ database, config, guest }), {
    ok: false,
    reason: "guest",
  });

  database.close();
});

test("clearing cookies does not reset the count for the same IP", () => {
  const { config, database } = setup({ GUEST_MESSAGE_LIMIT: "2" });

  consumeGuestMessage({ database, config, guest: { guestId: "g1", ipHash: "shared" } });
  consumeGuestMessage({ database, config, guest: { guestId: "g1", ipHash: "shared" } });

  // Same visitor, fresh cookie, same network.
  const result = consumeGuestMessage({
    database,
    config,
    guest: { guestId: "g2", ipHash: "shared" },
  });

  assert.deepEqual(result, { ok: false, reason: "guest" });
  database.close();
});

test("the global daily cap refuses beyond its limit, with a distinguishable reason", () => {
  const { config, database } = setup({
    GUEST_MESSAGE_LIMIT: "100",
    GUEST_DAILY_MESSAGE_LIMIT: "2",
  });

  consumeGuestMessage({ database, config, guest: { guestId: "a", ipHash: "a" } });
  consumeGuestMessage({ database, config, guest: { guestId: "b", ipHash: "b" } });

  assert.deepEqual(
    consumeGuestMessage({ database, config, guest: { guestId: "c", ipHash: "c" } }),
    { ok: false, reason: "daily" }
  );

  database.close();
});

test("no raw IP address is ever written to the database", () => {
  const { config, database } = setup();
  const ipHash = hashIp("203.0.113.42", config.sessionSecret);

  consumeGuestMessage({ database, config, guest: { guestId: "g1", ipHash } });

  const stored = database.connection
    .prepare("SELECT ip_hash FROM guest_usage WHERE guest_id = ?")
    .get("g1").ip_hash;

  assert.notEqual(stored, "203.0.113.42");
  assert.equal(stored, ipHash);
  assert.equal(stored.length, 64, "HMAC-SHA256 hex digest");
  database.close();
});

test("summarizeGuestAllowance reports what is left", () => {
  const { config, database } = setup({ GUEST_MESSAGE_LIMIT: "5" });
  const guest = { guestId: "g1", ipHash: "ip1" };

  consumeGuestMessage({ database, config, guest });
  const summary = summarizeGuestAllowance({ database, config, guest });

  assert.equal(summary.messagesUsed, 1);
  assert.equal(summary.messagesLimit, 5);
  assert.equal(summary.messagesRemaining, 4);
  database.close();
});

test("a visitor with no cookie yet is still counted by IP", () => {
  const { config, database } = setup({ GUEST_MESSAGE_LIMIT: "2" });

  consumeGuestMessage({ database, config, guest: { guestId: "g1", ipHash: "shared" } });

  // /api/me reads the allowance without issuing a cookie, so guestId can be null.
  const summary = summarizeGuestAllowance({
    database,
    config,
    guest: { guestId: null, ipHash: "shared" },
  });

  assert.equal(summary.messagesUsed, 1);
  assert.equal(summary.messagesRemaining, 1);
  database.close();
});

test("the guest model allowlist is a backstop, empty means everything", () => {
  const { config: open } = setup();
  assert.equal(isModelAllowedForGuests("gemini-2.5-pro", open), true);

  const { config: limited } = setup({ GUEST_MODEL_ALLOWLIST: "gemini-2.5-flash" });
  assert.equal(isModelAllowedForGuests("gemini-2.5-flash", limited), true);
  assert.equal(isModelAllowedForGuests("gemini-2.5-pro", limited), false);
});
