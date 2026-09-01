import assert from "node:assert/strict";
import test from "node:test";

import { buildAuth } from "../src/auth.js";
import { loadAuthConfig } from "../src/config.js";
import { openDatabase } from "../src/database.js";
import { createApp } from "../src/index.js";

const ORIGIN = "https://chat.philippeho.dev";

function setup() {
  const config = loadAuthConfig({
    NODE_ENV: "test",
    PUBLIC_ORIGIN: ORIGIN,
    SESSION_SECRET: "0".repeat(64),
    OWNER_EMAIL: "phil@example.com",
    OWNER_PASSWORD: "owner-password-long",
  });
  const database = openDatabase(":memory:");
  const auth = buildAuth({ connection: database.connection, config });
  const app = createApp({ database, auth, config });
  return { app, database, config, auth };
}

/** Start the app on an ephemeral port and return helpers bound to it. */
async function listen(app) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  return {
    url: (path) => `http://127.0.0.1:${port}${path}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("an unauthenticated caller is refused on a non-allowlisted API route", async () => {
  const { app, database } = setup();
  const server = await listen(app);

  const response = await fetch(server.url("/api/admin/users"));

  assert.equal(response.status, 401);
  await server.close();
  database.close();
});

test("allowlisted routes stay reachable without a session", async () => {
  const { app, database } = setup();
  const server = await listen(app);

  const response = await fetch(server.url("/api/me"));

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.authenticated, false);
  assert.equal(typeof body.guest.messagesRemaining, "number");

  await server.close();
  database.close();
});

test("an unsafe API request from a foreign origin is rejected before any session lookup", async () => {
  const { app, database } = setup();
  const server = await listen(app);

  const response = await fetch(server.url("/api/chat/stream"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
    body: JSON.stringify({ messages: [] }),
  });

  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.error.code, "ORIGIN_REJECTED");

  await server.close();
  database.close();
});

test("the Google quota dashboard is owner-only", async () => {
  const { app, database } = setup();
  const server = await listen(app);

  const response = await fetch(server.url("/api/usage"));

  assert.equal(response.status, 401);
  await server.close();
  database.close();
});
