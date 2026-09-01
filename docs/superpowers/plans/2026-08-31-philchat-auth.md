# philchat Auth Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace philchat's plaintext-password auth with Better Auth on SQLite, adding a public guest trial and per-user monthly token budgets.

**Architecture:** A `node:sqlite` database holds Better Auth's tables alongside philchat's own metering tables. Better Auth owns identity entirely — there is no second auth path. A single approval gate at session creation means holding a session proves approval, so no downstream route re-checks. Guests are counted by signed cookie and hashed IP in the same database; approved users are metered by tokens recorded from the provider usage both APIs already return.

**Tech Stack:** Node 24, Express 5, `better-auth` ^1.7.1, `node:sqlite` (`DatabaseSync`), React 19 + Tailwind 3, `node --test`.

**Spec:** `docs/superpowers/specs/2026-08-31-philchat-auth-design.md`

## Global Constraints

- **Node 24.** `Dockerfile` uses `node:24-alpine`. `node:sqlite` requires it.
- **Suppress the experimental warning** on every entrypoint: `node --disable-warning=ExperimentalWarning`. `node:sqlite` is noisy otherwise.
- **`better-auth` ^1.7.1.** Removed: `bcryptjs`, `express-session`. Added: `better-auth`, `cookie-parser`.
- **No zod.** philchat's `config.js` is hand-rolled; env validation matches that style.
- **No insecure fallbacks.** Every `|| 'dev-secret-change-in-production'` and `|| '0000'`-style default is deleted. Missing required config throws at boot.
- **SQL identifier convention:** Better Auth tables and columns are camelCase and double-quoted (`"user"`, `"approvalStatus"`). philchat's own tables are snake_case and unquoted (`usage_events`, `guest_usage`). `"user"` is a SQL reserved word and must stay quoted everywhere.
- **The `account` table MUST include `"issuer" text NOT NULL`.** Better Auth 1.7 requires it; hand-written DDL that omits it fails at first sign-up with `table account has no column named issuer`.
- **Cookie:** `__Host-philchat_session` in production, `philchat_session` otherwise, with `useSecureCookies: false` and `secure` set explicitly. Setting `useSecureCookies: true` emits `__Secure-__Host-philchat_session`, which browsers read as a plain `__Secure-` cookie.
- **Password floor 12 characters. Username 3–30.**
- **Tests** run from `server/` with `npm test` (`node --test`). Every test uses a `:memory:` database — no test touches `/data`.
- **Commit messages** are plain imperative sentences matching this repo's history (`Add global daily public message cap + fix lint`), not `feat:` prefixes. End each with:
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`
- **Branch:** all work lands on `philchat-auth`. Never push to `main` mid-rebuild — `main` auto-deploys via `.github/workflows/deploy.yml`.

## File Structure

| File | Responsibility |
| --- | --- |
| `server/src/database.js` | **Create.** Opens the SQLite connection, owns the migration runner and all DDL. |
| `server/src/auth.js` | **Rewrite from scratch.** Better Auth configuration and the approval gate. Nothing of the current file survives. |
| `server/src/owner.js` | **Create.** First-boot owner seed. |
| `server/src/guests.js` | **Create.** Guest identity cookie, per-guest and per-IP counting, global daily message cap. |
| `server/src/budget.js` | **Create.** Token accounting: pre-flight budget checks, post-stream usage recording. |
| `server/src/admin.js` | **Create.** Owner-only user administration routes. |
| `server/src/config.js` | **Modify.** Add `loadAuthConfig()` — boot-time env validation that throws. Remove `normalizeAppBasePath`. |
| `server/src/index.js` | **Modify.** Mount Better Auth, delete express-session, add origin check + default-deny, rewrite `/api/me`, wire guest and budget checks into the chat stream. |
| `webui/src/lib/authClient.js` | **Create.** Better Auth React client. |
| `webui/src/components/AuthModal.jsx` | **Create.** Replaces `LoginModal.jsx` (deleted). Sign-in/sign-up with pending, guest-limit and budget-exhausted states. |
| `webui/src/components/AdminPanel.jsx` | **Create.** Owner-only approvals and budget overrides. |
| `webui/src/lib/api.js` | **Modify.** Drop `login`/`logout`; add admin calls. |
| `webui/src/App.jsx` | **Modify.** Surgical edits only — this file is ~2100 lines and is not being restructured. |

---

## Task 1: Move to `chat.philippeho.dev` and delete the base path

Ships and is verified on its own. It is what makes `__Host-` possible, and doing it after the auth rewrite means redoing the cookie work.

**Files:**
- Modify: `Dockerfile`, `docker-compose.yml` (server-side), `ecosystem.config.cjs`, `.env.example`, `.github/workflows/deploy.yml`, `README.md`
- Modify: `server/src/index.js` (remove base-path mounting), `server/src/config.js` (remove `normalizeAppBasePath`), `webui/src/lib/paths.js`
- Test: `server/test/config.test.js` (remove the `normalizeAppBasePath` cases)

**Interfaces:**
- Consumes: nothing.
- Produces: the app served at `https://chat.philippeho.dev` with all routes at `/api/...` and no base path anywhere. Every later task assumes `PUBLIC_ORIGIN = https://chat.philippeho.dev`.

- [ ] **Step 1: Add the DNS record (user action)**

In Cloudflare, on `philippeho.dev`: `chat` → A → `95.217.6.255`, **DNS-only (grey cloud)**, matching every other subdomain on the box. Confirm with:

```bash
nslookup chat.philippeho.dev
```

Expected: `95.217.6.255`.

- [ ] **Step 2: Repoint the Traefik router**

Replace `/data/coolify/proxy/dynamic/philchat.yaml` on the server:

```yaml
http:
  routers:
    philchat-http:
      entryPoints:
        - http
      middlewares:
        - redirect-to-https
      priority: 100
      rule: 'Host(`chat.philippeho.dev`)'
      service: philchat
    philchat-https:
      entryPoints:
        - https
      priority: 100
      rule: 'Host(`chat.philippeho.dev`)'
      service: philchat
      tls:
        certresolver: letsencrypt
  services:
    philchat:
      loadBalancer:
        servers:
          - url: 'http://philchat:8791'
```

- [ ] **Step 3: Add the legacy redirect**

Create `/data/coolify/proxy/dynamic/philchat-redirect.yaml`, mirroring `manga-tracker-redirect.yaml`:

```yaml
http:
  routers:
    philchat-legacy-http:
      entryPoints:
        - http
      middlewares:
        - philchat-to-subdomain
      priority: 1000
      rule: 'Host(`philippeho.dev`) && (Path(`/philchat`) || PathPrefix(`/philchat/`))'
      service: noop@internal
    philchat-legacy-https:
      entryPoints:
        - https
      middlewares:
        - philchat-to-subdomain
      priority: 1000
      rule: 'Host(`philippeho.dev`) && (Path(`/philchat`) || PathPrefix(`/philchat/`))'
      service: noop@internal
      tls:
        certresolver: letsencrypt
  middlewares:
    philchat-to-subdomain:
      redirectRegex:
        regex: '^https?://philippeho\.dev/philchat(?:[/?].*)?$'
        replacement: 'https://chat.philippeho.dev'
        permanent: true
```

- [ ] **Step 4: Delete the base path from the repo**

In `Dockerfile`, drop `APP_BASE_PATH=/philchat` from the `ENV` line and bump the image (the Node bump belongs to Task 2; here only the env changes):

```dockerfile
ENV NODE_ENV=production PORT=8791 HOST=0.0.0.0
```

In `ecosystem.config.cjs`, delete the `APP_BASE_PATH` entry. In `.env.example`, delete `APP_BASE_PATH` and `VITE_BASE_PATH`. In `.github/workflows/deploy.yml`, delete the `env:` block under "Build web UI" so the build runs with no `VITE_BASE_PATH`. In `README.md`, delete the "For the AWS path deploy" block.

In `server/src/index.js`, delete the `APP_BASE_PATH` constant, the `normalizeAppBasePath` import, and replace the whole trailing conditional:

```js
// delete this entire block
if (APP_BASE_PATH) {
  app.use((request, response, next) => { ... });
  app.use(APP_BASE_PATH, router);
} else {
  app.use(router);
}
```

with:

```js
app.use(router);
```

In `server/src/config.js`, delete the `normalizeAppBasePath` export. `webui/src/lib/paths.js` keeps working unchanged (`BASE_URL` becomes `/`), so leave it — deleting it would touch every call site for no gain.

- [ ] **Step 5: Remove the base-path tests**

Delete every `normalizeAppBasePath` test from `server/test/config.test.js` and its name from the import list at the top of that file.

- [ ] **Step 6: Verify tests and lint pass**

Run from the repo root:

```bash
npm test && npm run lint
```

Expected: PASS, with no reference to `normalizeAppBasePath` remaining.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Move philchat to chat.philippeho.dev and drop the base path

A path on the shared apex means the session cookie sits in the same jar as
the portfolio, Billing Hub and PowerTree, and makes the __Host- cookie
prefix impossible. Must land before the auth rewrite that depends on it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 8: Deploy and verify routing before continuing**

Merge this task to `main` on its own (it is a safe, self-contained change) and let the workflow deploy it. Then:

```bash
curl -sSI https://chat.philippeho.dev/ | head -1
curl -sSI https://philippeho.dev/philchat | head -1
```

Expected: `HTTP/2 200` for the first; `HTTP/2 301` with `location: https://chat.philippeho.dev` for the second. Traefik returns 503 for 30–60s after a redeploy while it picks up the recreated container — poll rather than concluding failure. Load the page in a browser and confirm assets resolve without `/philchat/` in their paths.

**Do not start Task 2 until both URLs behave as above.**

---

## Task 2: Database module and migrations

**Files:**
- Create: `server/src/database.js`
- Modify: `Dockerfile`, `server/package.json`
- Test: `server/test/database.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `openDatabase(path: string) => { connection: DatabaseSync, transaction: (fn: () => T) => T, close: () => void }`
  - The connection is the raw `node:sqlite` `DatabaseSync` handed straight to Better Auth in Task 4.
  - Tables: `user`, `session`, `account`, `verification`, `rateLimit`, `usage_events`, `guest_usage`, `daily_budget`, `schema_migrations`.

- [ ] **Step 1: Bump Node and adjust the start commands**

`Dockerfile` first line:

```dockerfile
FROM node:24-alpine
```

and its last line:

```dockerfile
CMD ["node", "--disable-warning=ExperimentalWarning", "server/src/index.js"]
```

`server/package.json` scripts:

```json
"dev": "node --watch --disable-warning=ExperimentalWarning src/index.js",
"start": "node --disable-warning=ExperimentalWarning src/index.js",
"test": "node --test --disable-warning=ExperimentalWarning"
```

- [ ] **Step 2: Write the failing test**

Create `server/test/database.test.js`:

```js
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
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd server && npm test
```

Expected: FAIL — `Cannot find module '../src/database.js'`.

- [ ] **Step 4: Write the implementation**

Create `server/src/database.js`. The Better Auth DDL is copied from cloudsong's migration 3 (`personal-soundcloud`), with philchat's server-owned columns added to `"user"`:

```js
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Better Auth's own tables. Its identifiers are camelCase and double-quoted while ours
 * are snake_case; both are correct. `user` is a SQL reserved word and must stay quoted.
 *
 * The `issuer` column on `account` is not optional: Better Auth 1.7 writes to it, and
 * hand-written DDL that omits it fails at the first sign-up with
 * "table account has no column named issuer".
 */
const MIGRATIONS = [
  {
    version: 1,
    sql: `
      CREATE TABLE "user" (
        "id" text NOT NULL PRIMARY KEY,
        "name" text NOT NULL,
        "email" text NOT NULL UNIQUE,
        "emailVerified" integer NOT NULL,
        "image" text,
        "createdAt" date NOT NULL,
        "updatedAt" date NOT NULL,
        "username" text UNIQUE,
        "displayUsername" text,
        "role" text NOT NULL,
        "approvalStatus" text NOT NULL,
        "approvedAt" text,
        "approvedBy" text,
        "monthlyTokenBudget" integer
      );

      CREATE TABLE "session" (
        "id" text NOT NULL PRIMARY KEY,
        "expiresAt" date NOT NULL,
        "token" text NOT NULL UNIQUE,
        "createdAt" date NOT NULL,
        "updatedAt" date NOT NULL,
        "ipAddress" text,
        "userAgent" text,
        "userId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE
      );

      CREATE TABLE "account" (
        "id" text NOT NULL PRIMARY KEY,
        "issuer" text NOT NULL,
        "accountId" text NOT NULL,
        "providerId" text NOT NULL,
        "userId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
        "accessToken" text,
        "refreshToken" text,
        "idToken" text,
        "accessTokenExpiresAt" date,
        "refreshTokenExpiresAt" date,
        "scope" text,
        "password" text,
        "createdAt" date NOT NULL,
        "updatedAt" date NOT NULL
      );

      CREATE TABLE "verification" (
        "id" text NOT NULL PRIMARY KEY,
        "identifier" text NOT NULL,
        "value" text NOT NULL,
        "expiresAt" date NOT NULL,
        "createdAt" date NOT NULL,
        "updatedAt" date NOT NULL
      );

      CREATE TABLE "rateLimit" (
        "id" text NOT NULL PRIMARY KEY,
        "key" text NOT NULL UNIQUE,
        "count" integer NOT NULL,
        "lastRequest" bigint NOT NULL
      );

      CREATE INDEX "session_userId_idx" ON "session" ("userId");
      CREATE INDEX "account_userId_idx" ON "account" ("userId");
      CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");
      CREATE UNIQUE INDEX "account_issuer_accountId_uidx" ON "account" ("issuer", "accountId");
    `,
  },
  {
    version: 2,
    sql: `
      -- user_id is SET NULL rather than CASCADE on purpose: deleting an account must not
      -- erase the spend history that justified its budget.
      CREATE TABLE usage_events (
        id                TEXT NOT NULL PRIMARY KEY,
        user_id           TEXT REFERENCES "user"("id") ON DELETE SET NULL,
        guest_id          TEXT,
        provider          TEXT NOT NULL,
        model_id          TEXT NOT NULL,
        prompt_tokens     INTEGER,
        completion_tokens INTEGER,
        total_tokens      INTEGER,
        created_at        TEXT NOT NULL
      );
      CREATE INDEX usage_events_user_created_idx ON usage_events(user_id, created_at);
      CREATE INDEX usage_events_guest_idx        ON usage_events(guest_id);
      CREATE INDEX usage_events_created_idx      ON usage_events(created_at);

      CREATE TABLE guest_usage (
        guest_id      TEXT NOT NULL PRIMARY KEY,
        ip_hash       TEXT NOT NULL,
        messages_used INTEGER NOT NULL DEFAULT 0,
        first_seen    TEXT NOT NULL,
        last_seen     TEXT NOT NULL
      );
      CREATE INDEX guest_usage_ip_idx ON guest_usage(ip_hash);

      CREATE TABLE daily_budget (
        date           TEXT NOT NULL PRIMARY KEY,
        guest_messages INTEGER NOT NULL DEFAULT 0,
        tokens         INTEGER NOT NULL DEFAULT 0
      );
    `,
  },
];

class Database {
  constructor(filePath) {
    if (filePath !== ":memory:") {
      mkdirSync(path.dirname(filePath), { recursive: true });
    }

    this.connection = new DatabaseSync(filePath);
    this.connection.exec("PRAGMA foreign_keys = ON");
    this.connection.exec("PRAGMA journal_mode = WAL");
    this.migrate();
  }

  /**
   * Apply every migration this database has not recorded yet. Each step runs inside its
   * own transaction and records its version in that same transaction, so a crash
   * mid-upgrade leaves the database at the last fully applied version rather than
   * half-migrated.
   */
  migrate() {
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);

    const applied = new Set(
      this.connection
        .prepare("SELECT version FROM schema_migrations")
        .all()
        .map((row) => Number(row.version))
    );

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;

      this.connection.exec("BEGIN IMMEDIATE");
      try {
        this.connection.exec(migration.sql);
        this.connection
          .prepare(
            "INSERT OR REPLACE INTO schema_migrations(version, applied_at) VALUES (?, ?)"
          )
          .run(migration.version, new Date().toISOString());
        this.connection.exec("COMMIT");
      } catch (error) {
        this.connection.exec("ROLLBACK");
        throw error;
      }
    }
  }

  transaction(callback) {
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.connection.exec("COMMIT");
      return result;
    } catch (error) {
      this.connection.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.connection.close();
  }
}

export function openDatabase(filePath) {
  return new Database(filePath);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd server && npm test
```

Expected: PASS, 4 new tests.

- [ ] **Step 6: Commit**

```bash
git add server/src/database.js server/test/database.test.js server/package.json Dockerfile
git commit -m "$(cat <<'EOF'
Add SQLite database module with migration runner

Better Auth's tables live in the same file as philchat's metering tables, so
one backup covers both. Each migration commits its own version so a crash
leaves the database at the last fully applied version.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Boot-time config validation

**Files:**
- Modify: `server/src/config.js`
- Test: `server/test/config.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `loadAuthConfig(env = process.env) => { environment, isProduction, publicOrigin, sessionSecret, ownerUsername, ownerEmail, ownerPassword, databasePath, sessionMaxAgeSeconds, guestMessageLimit, guestDailyMessageLimit, guestModelAllowlist, defaultMonthlyTokenBudget, globalDailyTokenLimit }`. Throws `AppError` on invalid input. `guestModelAllowlist` is a `string[]`; empty array means "all models allowed".

- [ ] **Step 1: Write the failing test**

Append to `server/test/config.test.js` (and add `loadAuthConfig` to the existing import list at the top):

```js
const VALID_AUTH_ENV = {
  NODE_ENV: "production",
  PUBLIC_ORIGIN: "https://chat.philippeho.dev",
  SESSION_SECRET: "0".repeat(64),
  OWNER_EMAIL: "phil@example.com",
  OWNER_PASSWORD: "a-long-enough-password",
};

test("loadAuthConfig accepts a complete environment and applies defaults", () => {
  const config = loadAuthConfig(VALID_AUTH_ENV);

  assert.equal(config.publicOrigin, "https://chat.philippeho.dev");
  assert.equal(config.isProduction, true);
  assert.equal(config.ownerUsername, "phil");
  assert.equal(config.databasePath, "/data/philchat.sqlite");
  assert.equal(config.guestMessageLimit, 5);
  assert.equal(config.guestDailyMessageLimit, 50);
  assert.deepEqual(config.guestModelAllowlist, []);
  assert.equal(config.defaultMonthlyTokenBudget, 500_000);
  assert.equal(config.globalDailyTokenLimit, 2_000_000);
});

test("loadAuthConfig throws when SESSION_SECRET is missing or too short", () => {
  assert.throws(
    () => loadAuthConfig({ ...VALID_AUTH_ENV, SESSION_SECRET: undefined }),
    /SESSION_SECRET/
  );
  assert.throws(
    () => loadAuthConfig({ ...VALID_AUTH_ENV, SESSION_SECRET: "short" }),
    /SESSION_SECRET/
  );
});

test("loadAuthConfig rejects a PUBLIC_ORIGIN that carries a path", () => {
  assert.throws(
    () => loadAuthConfig({ ...VALID_AUTH_ENV, PUBLIC_ORIGIN: "https://philippeho.dev/philchat" }),
    /PUBLIC_ORIGIN/
  );
});

test("loadAuthConfig enforces the 12-character owner password floor", () => {
  assert.throws(
    () => loadAuthConfig({ ...VALID_AUTH_ENV, OWNER_PASSWORD: "tooshort" }),
    /OWNER_PASSWORD/
  );
});

test("loadAuthConfig parses the guest model allowlist into a trimmed array", () => {
  const config = loadAuthConfig({
    ...VALID_AUTH_ENV,
    GUEST_MODEL_ALLOWLIST: " gemini-2.5-flash , meta/llama-3.1-8b-instruct ",
  });

  assert.deepEqual(config.guestModelAllowlist, [
    "gemini-2.5-flash",
    "meta/llama-3.1-8b-instruct",
  ]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server && npm test
```

Expected: FAIL — `loadAuthConfig is not a function`.

- [ ] **Step 3: Write the implementation**

Add to `server/src/config.js`, in the existing hand-rolled style (no zod):

```js
export const DEFAULT_DATABASE_PATH = "/data/philchat.sqlite";
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

function requireEnvString(env, name, { minLength = 1 } = {}) {
  const value = String(env[name] ?? "").trim();

  if (value.length < minLength) {
    throw new AppError(
      `${name} must be set to at least ${minLength} character(s). Refusing to start — ` +
        "an app running on a missing or default secret fails silently; this fails loudly.",
      { httpCode: 500 }
    );
  }

  return value;
}

function optionalEnvNumber(env, name, fallback) {
  const raw = String(env[name] ?? "").trim();
  if (!raw) return fallback;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new AppError(`${name} must be a positive integer.`, { httpCode: 500 });
  }

  return parsed;
}

/**
 * Boot-time configuration for auth, guests and budgets.
 *
 * Every required value throws rather than falling back. The audit's standing finding is
 * that insecure defaults survive for weeks precisely because nothing forces the issue.
 */
export function loadAuthConfig(env = process.env) {
  const environment = String(env.NODE_ENV ?? "development").trim() || "development";
  const publicOriginRaw = requireEnvString(env, "PUBLIC_ORIGIN");

  let publicOrigin;
  try {
    const parsed = new URL(publicOriginRaw);
    if (parsed.pathname !== "/") {
      throw new Error("path");
    }
    publicOrigin = parsed.origin;
  } catch {
    throw new AppError(
      "PUBLIC_ORIGIN must be an absolute URL with no path, e.g. https://chat.philippeho.dev",
      { httpCode: 500 }
    );
  }

  const allowlist = String(env.GUEST_MODEL_ALLOWLIST ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return {
    environment,
    isProduction: environment === "production",
    publicOrigin,
    sessionSecret: requireEnvString(env, "SESSION_SECRET", { minLength: 32 }),
    ownerUsername: String(env.OWNER_USERNAME ?? "").trim() || "phil",
    ownerEmail: requireEnvString(env, "OWNER_EMAIL"),
    // Bootstrap only: used on the first boot that finds no owner row, ignored for ever
    // after. The 12-character floor matches the sign-up minimum — the owner must not be
    // the weakest account on the site.
    ownerPassword: requireEnvString(env, "OWNER_PASSWORD", { minLength: 12 }),
    databasePath: String(env.PHILCHAT_DB_PATH ?? "").trim() || DEFAULT_DATABASE_PATH,
    sessionMaxAgeSeconds: SESSION_MAX_AGE_SECONDS,
    guestMessageLimit: optionalEnvNumber(env, "GUEST_MESSAGE_LIMIT", 5),
    guestDailyMessageLimit: optionalEnvNumber(env, "GUEST_DAILY_MESSAGE_LIMIT", 50),
    guestModelAllowlist: allowlist,
    defaultMonthlyTokenBudget: optionalEnvNumber(env, "DEFAULT_MONTHLY_TOKEN_BUDGET", 500_000),
    globalDailyTokenLimit: optionalEnvNumber(env, "GLOBAL_DAILY_TOKEN_LIMIT", 2_000_000),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd server && npm test
```

Expected: PASS, 5 new tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/config.js server/test/config.test.js
git commit -m "$(cat <<'EOF'
Validate auth config at boot and throw on missing secrets

Replaces the silent 'dev-secret-change-in-production' style of default. An
app that will not boot is a loud failure; one running on a known default is
a silent one.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Better Auth and the approval gate

**Files:**
- Rewrite: `server/src/auth.js` (delete the entire current contents)
- Create: `server/src/owner.js`
- Modify: `server/package.json`
- Test: `server/test/auth.test.js`

**Interfaces:**
- Consumes: `openDatabase` (Task 2), `loadAuthConfig` (Task 3).
- Produces:
  - `buildAuth({ connection, config }) => auth` — a Better Auth instance. `auth.handler`, `auth.api.getSession`, `auth.api.signUpEmail`, `auth.api.signInUsername` are used by later tasks.
  - `ensureOwner({ auth, connection, config, log }) => Promise<string>` — the owner's user id.

- [ ] **Step 1: Add and remove dependencies**

```bash
cd server
npm install better-auth@^1.7.1 cookie-parser
npm uninstall bcryptjs express-session
```

- [ ] **Step 2: Write the failing test**

Create `server/test/auth.test.js`:

```js
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
  assert.equal(sessions, 0, "autoSignIn must be off — sign-up must never mint a session");

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
      // Better Auth throws APIError; the gate sets this code.
      assert.match(JSON.stringify(error.body ?? error.message), /ACCOUNT_PENDING/);
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
```

> If `assert.rejects` fails because the error shape differs from the assumption above, log
> the caught error once, then assert on its **actual** shape. Do not weaken this to a bare
> `assert.rejects` — the test's value is proving the gate fired for the right reason.

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd server && npm test
```

Expected: FAIL — `buildAuth is not exported` / `Cannot find module '../src/owner.js'`.

- [ ] **Step 4: Replace `server/src/auth.js` entirely**

Delete every line of the current file — `verifyCredentials`, `isAuthEnabled`, `ADMIN_PASSWORD`, `EXTRA_USERS`, the `$2` bcrypt branch, the plaintext `===`, and the in-memory `dailyBucket`. Nothing survives; that is the point.

```js
import { APIError, betterAuth } from "better-auth";
import { username } from "better-auth/plugins";

/**
 * Better Auth owns identity entirely; there is no second auth path.
 *
 * It is handed the app's own DatabaseSync, so its tables live in the same SQLite file as
 * the usage tables — one backup covers both, and usage_events.user_id can be a real
 * foreign key.
 */
export function buildAuth({ connection, config }) {
  const isProduction = config.isProduction;

  return betterAuth({
    database: connection,
    secret: config.sessionSecret,
    baseURL: config.publicOrigin,
    trustedOrigins: [config.publicOrigin.replace(/\/$/, "")],

    emailAndPassword: {
      enabled: true,
      // Sign-up must never mint a session. Together with the gate below, this guarantees
      // a pending user never holds one at any point in their lifecycle.
      autoSignIn: false,
      minPasswordLength: 12,
      // The address is collected but deliberately never verified — the owner's approval
      // is the human check, so there is no SMTP dependency anywhere in this app.
      requireEmailVerification: false,
    },

    session: {
      expiresIn: config.sessionMaxAgeSeconds,
    },

    user: {
      additionalFields: {
        // `input: false` marks these server-owned: Better Auth strips them from any
        // request body, so a sign-up POST carrying "role":"owner" cannot escalate.
        // Privilege escalation is closed by construction rather than by vigilance.
        role: { type: "string", required: true, defaultValue: "member", input: false },
        approvalStatus: {
          type: "string",
          required: true,
          defaultValue: "pending",
          input: false,
        },
        approvedAt: { type: "string", required: false, input: false },
        approvedBy: { type: "string", required: false, input: false },
        // null means "use DEFAULT_MONTHLY_TOKEN_BUDGET"; a number overrides it per user.
        monthlyTokenBudget: { type: "number", required: false, input: false },
      },
    },

    databaseHooks: {
      session: {
        create: {
          /**
           * The approval gate, and the only one in the codebase.
           *
           * Because it sits at session creation, the existence of a session proves the
           * user is approved — no downstream route re-checks, and there is no
           * half-authenticated state for an authorization bug to hide in.
           */
          before: async (session) => {
            const row = connection
              .prepare('SELECT "approvalStatus" FROM "user" WHERE "id" = ?')
              .get(session.userId);

            if (row?.approvalStatus === "pending") {
              throw new APIError("FORBIDDEN", {
                code: "ACCOUNT_PENDING",
                message: "This account is waiting to be approved.",
              });
            }

            if (row?.approvalStatus !== "approved") {
              throw new APIError("FORBIDDEN", {
                code: "ACCOUNT_REJECTED",
                message: "This account cannot sign in.",
              });
            }

            return { data: session };
          },
        },
      },
    },

    rateLimit: {
      enabled: true,
      // Database storage, so counters survive a restart instead of resetting to zero on
      // every deploy the way an in-process limiter does.
      storage: "database",
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/username": { window: 15 * 60, max: 5 },
        "/sign-in/email": { window: 15 * 60, max: 5 },
        // Public sign-up is a spam vector the old single-password login never had.
        "/sign-up/email": { window: 60 * 60, max: 3 },
      },
    },

    advanced: {
      /**
       * Counterintuitive but deliberate: `useSecureCookies` controls only Better Auth's
       * automatic `__Secure-` name prefix, not the Secure attribute itself. Leaving it
       * false and setting `secure` explicitly below is the only way to get a literal
       * `__Host-` name — with it true the cookie is emitted as
       * `__Secure-__Host-philchat_session`, which browsers read as a plain `__Secure-`
       * cookie, silently losing the stronger subdomain-overwrite guarantee.
       */
      useSecureCookies: false,
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: "strict",
        path: "/",
        secure: isProduction,
      },
      cookies: {
        // `__Host-` additionally requires Secure, Path=/ and no Domain — all satisfied
        // above. It is dropped outside production, where Secure is not set.
        session_token: {
          name: isProduction ? "__Host-philchat_session" : "philchat_session",
        },
      },
    },

    plugins: [username({ minUsernameLength: 3, maxUsernameLength: 30 })],
  });
}
```

- [ ] **Step 5: Write `server/src/owner.js`**

```js
/**
 * Create the owner account on first boot.
 *
 * The configured password is used exactly once. If an owner row already exists the
 * OWNER_* variables are ignored entirely — this is a bootstrap, never a standing back
 * door that silently resets the owner's password on every deploy. Recovery, if ever
 * needed, is a deliberate script run against the SQLite file over SSH.
 *
 * Returns the owner's user id.
 */
export async function ensureOwner({ auth, connection, config, log }) {
  const existing = connection
    .prepare(`SELECT "id" FROM "user" WHERE "role" = 'owner' LIMIT 1`)
    .get();

  if (existing?.id) {
    return existing.id;
  }

  // Created through Better Auth's own sign-up API so the credential hash format is
  // identical to every other account's, rather than a second thing to keep in step.
  await auth.api.signUpEmail({
    body: {
      email: config.ownerEmail,
      name: config.ownerUsername,
      username: config.ownerUsername,
      password: config.ownerPassword,
    },
  });

  const created = connection
    .prepare('SELECT "id" FROM "user" WHERE "username" = ?')
    .get(config.ownerUsername);

  // `role` and `approvalStatus` are `input: false`, so they cannot be set through the
  // sign-up body — deliberately, since that is what stops anyone else setting them. The
  // owner is promoted here instead.
  connection
    .prepare(
      `UPDATE "user" SET "role" = 'owner', "approvalStatus" = 'approved', "approvedAt" = ?
       WHERE "id" = ?`
    )
    .run(new Date().toISOString(), created.id);

  log?.(`seeded owner account "${config.ownerUsername}"`);
  return created.id;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd server && npm test
```

Expected: PASS, 5 new tests.

- [ ] **Step 7: Commit**

```bash
git add server/src/auth.js server/src/owner.js server/test/auth.test.js server/package.json server/package-lock.json
git commit -m "$(cat <<'EOF'
Replace plaintext password auth with Better Auth

Deletes verifyCredentials, ADMIN_PASSWORD, EXTRA_USERS and the plaintext
=== comparison outright. No second auth path survives, which is what closes
the finding rather than a stronger value in the same variable.

The approval gate sits at session creation, so holding a session proves
approval and no downstream route has to re-check.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Mount Better Auth and lock down the routes

**Files:**
- Modify: `server/src/index.js`
- Test: `server/test/routes.test.js`

**Interfaces:**
- Consumes: `buildAuth`, `ensureOwner` (Task 4), `openDatabase` (Task 2), `loadAuthConfig` (Task 3).
- Produces:
  - `createApp({ database, auth, config }) => express.Application` — extracted so tests can build an app without listening on a port.
  - `request.authUser` (the Better Auth user object or `null`) and `request.isOwner` (boolean) on every request.

- [ ] **Step 1: Write the failing test**

Create `server/test/routes.test.js`:

```js
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

/** Start the app on an ephemeral port and return a fetch bound to it. */
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server && npm test
```

Expected: FAIL — `createApp is not exported from ../src/index.js`.

- [ ] **Step 3: Restructure `server/src/index.js`**

Extract the app construction into an exported `createApp` and keep listening behind an entrypoint guard. Replace the top of the file (imports through the session middleware) with:

```js
import cookieParser from "cookie-parser";
import express from "express";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildAuth } from "./auth.js";
import { registerAdminRoutes } from "./admin.js";
import { AppError, buildBootstrapPayload, loadAuthConfig, loadRuntimeConfig } from "./config.js";
import { openDatabase } from "./database.js";
import { ensureOwner } from "./owner.js";

// Unchanged, keep exactly as they are today:
//   ./providers.js — fetchProviderModels, normalizeProviderStreamChunk,
//                    openProviderChatStream, PROVIDER_NVIDIA, verifyProviderConnections
//   ./sse.js       — sendSseEvent, streamGoogleSse
//   ./nvidia.js    — streamNvidiaSse
//   ./usage.js     — fetchQuotaDashboard

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WEBUI_DIST_PATH = path.resolve(__dirname, "../../webui/dist");

/**
 * Routes any visitor may call. Everything else under /api/ requires a session — the
 * allowlist is explicit so adding a route never silently opens it.
 */
const PUBLIC_ROUTES = [
  // Better Auth's own handler. Sign-up and sign-in must be reachable without a session,
  // and its internal routes police themselves.
  { method: "GET", pattern: /^\/api\/auth\// },
  { method: "POST", pattern: /^\/api\/auth\// },
  { method: "GET", pattern: /^\/api\/bootstrap$/ },
  { method: "GET", pattern: /^\/api\/models$/ },
  { method: "GET", pattern: /^\/api\/me$/ },
  // The guest trial itself. Limited in guests.js, not here.
  { method: "POST", pattern: /^\/api\/chat\/stream$/ },
];

function errorPayload(code, message) {
  return { error: { code, message } };
}

export function createApp({ database, auth, config }) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.use(cookieParser(config.sessionSecret));

  // Better Auth's handler must be mounted BEFORE express.json(). It reads the raw body
  // itself; a parsed body arrives empty and every sign-in fails in a way that looks like
  // a credential problem.
  app.all("/api/auth/*splat", toNodeHandler(auth));

  app.use(express.json({ limit: "1mb" }));

  app.use(async (request, response, next) => {
    const requestPath = request.path;
    const isApi = requestPath.startsWith("/api/");
    const isUnsafe = !["GET", "HEAD", "OPTIONS"].includes(request.method);

    // Checked before the session is resolved, so a cross-origin caller gets nothing —
    // not even the cost of a session lookup.
    if (isApi && isUnsafe && request.headers.origin !== config.publicOrigin) {
      response
        .status(403)
        .json(errorPayload("ORIGIN_REJECTED", "Request origin is not allowed."));
      return;
    }

    try {
      const session = await auth.api.getSession({
        headers: fromNodeHeaders(request.headers),
      });
      request.authUser = session?.user ?? null;
    } catch {
      request.authUser = null;
    }

    request.isOwner = request.authUser?.role === "owner";

    if (!isApi || request.authUser) {
      next();
      return;
    }

    const isPublic = PUBLIC_ROUTES.some(
      (route) => route.method === request.method && route.pattern.test(requestPath)
    );

    if (isPublic) {
      next();
      return;
    }

    response.status(401).json(errorPayload("UNAUTHORIZED", "Authentication required."));
  });

  const router = express.Router();

  // Move the existing route handlers here verbatim, in their current order:
  //   GET  /api/me            (rewritten in Step 5)
  //   GET  /api/bootstrap     (unchanged)
  //   GET  /api/models        (unchanged)
  //   GET  /api/usage         (owner check added in Step 6)
  //   POST /api/chat/stream   (guest gate added in Task 6, budget in Task 7)
  //   the /assets and static handlers, then the SPA fallback, last as they are today.
  // POST /api/login and POST /api/logout are deleted, not moved.
  registerAdminRoutes(router, { database, config });
  app.use(router);

  app.use((error, _request, response, _next) => {
    const normalizedError = toClientError(error);
    response.status(normalizedError.httpCode || 500).json(normalizedError);
  });

  return app;
}
```

Then the entrypoint at the bottom of the file:

```js
const config = loadAuthConfig();
const database = openDatabase(config.databasePath);
const auth = buildAuth({ connection: database.connection, config });

await ensureOwner({ auth, connection: database.connection, config, log: console.log });

const app = createApp({ database, auth, config });
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 8787);

app.listen(PORT, HOST, () => {
  console.log(`philchat server listening on http://${HOST}:${PORT}`);
});
```

- [ ] **Step 4: Delete the old auth surface**

Remove from `server/src/index.js`: the `express-session` import and middleware, `POST /api/login`, `POST /api/logout`, and the `verifyCredentials` / `isAuthEnabled` / `getPublicMessageLimit` / `getDailyLimitStatus` / `consumeDailyMessage` imports. Better Auth owns all of it now.

- [ ] **Step 5: Rewrite `GET /api/me`**

```js
router.get("/api/me", (request, response) => {
  if (request.authUser) {
    const usage = summarizeUserBudget({ database, config, user: request.authUser });
    const pendingUserCount = request.isOwner
      ? database.connection
          .prepare(`SELECT COUNT(*) AS count FROM "user" WHERE "approvalStatus" = 'pending'`)
          .get().count
      : undefined;

    response.json({
      authenticated: true,
      user: {
        id: request.authUser.id,
        username: request.authUser.username,
        role: request.authUser.role,
      },
      usage,
      ...(pendingUserCount === undefined ? {} : { pendingUserCount }),
    });
    return;
  }

  const guest = {
    guestId: request.signedCookies?.philchat_guest ?? null,
    ipHash: hashIp(request.ip, config.sessionSecret),
  };

  response.json({
    authenticated: false,
    guest: summarizeGuestAllowance({ database, config, guest }),
  });
});
```

`summarizeUserBudget` comes from Task 7 and `summarizeGuestAllowance` + `hashIp` from Task 6. Implement this route in **Task 7**, after both exist; for now have `/api/me` return `{ authenticated: false, guest: { messagesUsed: 0, messagesRemaining: config.guestMessageLimit } }` so this task's test passes, and replace it in Task 7.

- [ ] **Step 6: Make `/api/usage` owner-only**

Add as the first lines of the existing `/api/usage` handler:

```js
if (!request.isOwner) {
  response.status(403).json(errorPayload("FORBIDDEN", "Owner access required."));
  return;
}
```

(The default-deny middleware already returns 401 for anonymous callers, since `/api/usage` is not on the allowlist. This second check separates a member from the owner.)

- [ ] **Step 7: Stub the admin routes so the import resolves**

Create `server/src/admin.js` with a minimal export; Task 8 fills it in:

```js
export function registerAdminRoutes(_router, _options) {}
```

- [ ] **Step 8: Run the tests to verify they pass**

```bash
cd server && npm test
```

Expected: PASS, 4 new tests.

- [ ] **Step 9: Commit**

```bash
git add server/src/index.js server/src/admin.js server/test/routes.test.js
git commit -m "$(cat <<'EOF'
Mount Better Auth and default-deny the API

Adds an explicit public-route allowlist so adding a route never silently
opens it, an origin check that runs before the session lookup, and moves the
Google quota dashboard behind owner access — it was returning project quota
to anyone who asked.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Guest trial

**Files:**
- Create: `server/src/guests.js`
- Modify: `server/src/index.js` (chat stream handler)
- Test: `server/test/guests.test.js`

**Interfaces:**
- Consumes: `openDatabase` (Task 2), `loadAuthConfig` (Task 3).
- Produces:
  - `resolveGuest({ request, response, config }) => { guestId: string, ipHash: string }` — reads or issues the signed cookie.
  - `hashIp(ip: string, secret: string) => string` — HMAC-SHA256 hex digest.
  - `summarizeGuestAllowance({ database, config, guest }) => { messagesUsed, messagesLimit, messagesRemaining, dailyRemaining }` — takes a `guest`, never a `request`; `guest.guestId` may be `null` (the IP count still applies).
  - `consumeGuestMessage({ database, config, guest }) => { ok: true } | { ok: false, reason: "guest" | "daily" }`
  - `isModelAllowedForGuests(modelId, config) => boolean`

- [ ] **Step 1: Write the failing test**

Create `server/test/guests.test.js`:

```js
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
  assert.equal(summary.messagesRemaining, 4);
  database.close();
});

test("the guest model allowlist is a backstop, empty means everything", () => {
  const { config: open } = setup();
  assert.equal(isModelAllowedForGuests("gemini-2.5-pro", open), true);

  const { config: limited } = setup({ GUEST_MODEL_ALLOWLIST: "gemini-2.5-flash" });
  assert.equal(isModelAllowedForGuests("gemini-2.5-flash", limited), true);
  assert.equal(isModelAllowedForGuests("gemini-2.5-pro", limited), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server && npm test
```

Expected: FAIL — `Cannot find module '../src/guests.js'`.

- [ ] **Step 3: Write the implementation**

Create `server/src/guests.js`:

```js
import { createHmac, randomUUID } from "node:crypto";

const GUEST_COOKIE = "philchat_guest";

export function hashIp(ip, secret) {
  return createHmac("sha256", secret).update(String(ip ?? "")).digest("hex");
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Read the guest's signed cookie, issuing one lazily if this is their first chat request.
 *
 * Issued on the first *chat* request rather than the first page view: the previous
 * implementation set `saveUninitialized: true`, handing a cookie to every visitor who
 * loaded the page, which is both a privacy wart and useless for the limit it enforces.
 */
export function resolveGuest({ request, response, config }) {
  const existing = request.signedCookies?.[GUEST_COOKIE];
  const guestId = typeof existing === "string" && existing ? existing : randomUUID();

  if (guestId !== existing) {
    response.cookie(GUEST_COOKIE, guestId, {
      httpOnly: true,
      sameSite: "strict",
      secure: config.isProduction,
      signed: true,
      path: "/",
      maxAge: 365 * 24 * 60 * 60 * 1000,
    });
  }

  return { guestId, ipHash: hashIp(request.ip, config.sessionSecret) };
}

/**
 * Messages already spent by this visitor.
 *
 * Takes the higher of the cookie's count and every count seen from the same hashed IP, so
 * clearing cookies does not hand out a fresh allowance. A VPN or a new mobile IP still
 * defeats this; the global daily cap is the actual spend backstop.
 */
function messagesUsed({ database, guest }) {
  const byGuest =
    database.connection
      .prepare("SELECT messages_used FROM guest_usage WHERE guest_id = ?")
      .get(guest.guestId)?.messages_used ?? 0;

  const byIp =
    database.connection
      .prepare("SELECT SUM(messages_used) AS total FROM guest_usage WHERE ip_hash = ?")
      .get(guest.ipHash)?.total ?? 0;

  return Math.max(Number(byGuest), Number(byIp));
}

export function summarizeGuestAllowance({ database, config, guest }) {
  const used = messagesUsed({ database, guest });
  const dailyUsed =
    database.connection
      .prepare("SELECT guest_messages FROM daily_budget WHERE date = ?")
      .get(todayUTC())?.guest_messages ?? 0;

  return {
    messagesUsed: used,
    messagesLimit: config.guestMessageLimit,
    messagesRemaining: Math.max(0, config.guestMessageLimit - used),
    dailyRemaining: Math.max(0, config.guestDailyMessageLimit - Number(dailyUsed)),
  };
}

export function isModelAllowedForGuests(modelId, config) {
  if (config.guestModelAllowlist.length === 0) return true;
  return config.guestModelAllowlist.includes(modelId);
}

/**
 * Spend one guest message. Both counters move in one transaction, before the upstream
 * stream opens — a guest message is spent whether or not the model answers.
 */
export function consumeGuestMessage({ database, config, guest }) {
  return database.transaction(() => {
    if (messagesUsed({ database, guest }) >= config.guestMessageLimit) {
      return { ok: false, reason: "guest" };
    }

    const today = todayUTC();
    const dailyUsed =
      database.connection
        .prepare("SELECT guest_messages FROM daily_budget WHERE date = ?")
        .get(today)?.guest_messages ?? 0;

    if (Number(dailyUsed) >= config.guestDailyMessageLimit) {
      return { ok: false, reason: "daily" };
    }

    const now = new Date().toISOString();

    database.connection
      .prepare(
        `INSERT INTO guest_usage (guest_id, ip_hash, messages_used, first_seen, last_seen)
         VALUES (?, ?, 1, ?, ?)
         ON CONFLICT(guest_id) DO UPDATE SET
           messages_used = messages_used + 1,
           last_seen = excluded.last_seen`
      )
      .run(guest.guestId, guest.ipHash, now, now);

    database.connection
      .prepare(
        `INSERT INTO daily_budget (date, guest_messages, tokens) VALUES (?, 1, 0)
         ON CONFLICT(date) DO UPDATE SET guest_messages = guest_messages + 1`
      )
      .run(today);

    return { ok: true };
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd server && npm test
```

Expected: PASS, 6 new tests.

- [ ] **Step 5: Wire the guest gate into the chat stream**

In `server/src/index.js`, replace the entire `if (!request.session.user && isAuthEnabled())` block at the top of `POST /api/chat/stream` with:

```js
let guest = null;

if (!request.authUser) {
  guest = resolveGuest({ request, response, config });

  if (!isModelAllowedForGuests(request.body?.modelId, config)) {
    beginSseResponse(response);
    sendSseEvent(response, "error", {
      httpCode: 403,
      googleStatus: null,
      message: "That model is not available without an account. Sign in to use it.",
      modelId: request.body?.modelId ?? null,
      provider: null,
      details: { modelNotAllowed: true },
    });
    response.end();
    return;
  }

  const spend = consumeGuestMessage({ database, config, guest });

  if (!spend.ok) {
    beginSseResponse(response);
    sendSseEvent(response, "error", {
      httpCode: 429,
      googleStatus: null,
      message:
        spend.reason === "guest"
          ? `You've used all ${config.guestMessageLimit} guest messages. Create an account to keep going.`
          : "Today's public message budget is used up. Come back tomorrow.",
      modelId: request.body?.modelId ?? null,
      provider: null,
      details:
        spend.reason === "guest"
          ? { limitReached: true, limit: config.guestMessageLimit }
          : { dailyLimitReached: true, limit: config.guestDailyMessageLimit },
    });
    response.end();
    return;
  }
}
```

The three SSE header lines are repeated four times in this handler already; extract them once near the other helpers:

```js
function beginSseResponse(response) {
  response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders?.();
}
```

and use it for the existing success path too.

- [ ] **Step 6: Run the full suite**

```bash
cd server && npm test
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/guests.js server/src/index.js server/test/guests.test.js
git commit -m "$(cat <<'EOF'
Persist guest limits in SQLite, counted by cookie and hashed IP

The in-process counters reset to zero on every deploy and a guest reset
their own allowance by clearing cookies. Counting now takes the higher of
the two, and only an HMAC of the IP is stored.

The guest cookie is issued on the first chat request rather than the first
page view, so a visitor who never chats is never given one.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Token budgets

**Files:**
- Create: `server/src/budget.js`
- Modify: `server/src/index.js` (chat stream handler, `/api/me`)
- Test: `server/test/budget.test.js`

**Interfaces:**
- Consumes: `openDatabase` (Task 2), `loadAuthConfig` (Task 3).
- Produces:
  - `monthStartISO(now = new Date()) => string`
  - `effectiveBudget(user, config) => number`
  - `checkBudget({ database, config, user }) => { ok: true } | { ok: false, scope: "user" | "global" }`
  - `recordUsage({ database, usage, user, guest, provider, modelId }) => void`
  - `summarizeUserBudget({ database, config, user }) => { tokensUsed, tokenBudget, tokensRemaining }`

- [ ] **Step 1: Write the failing test**

Create `server/test/budget.test.js`:

```js
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
    .run("u1", "alice", "alice@example.com", "2026-08-01", "2026-08-01", "alice", "member");

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

  insertUsage(database, { userId: "u1", tokens: 500, createdAt: "2026-07-15T00:00:00.000Z" });

  const summary = summarizeUserBudget({ database, config, user });
  assert.equal(summary.tokensUsed, 0);
  assert.deepEqual(checkBudget({ database, config, user }), { ok: true });

  database.close();
});

test("a user at their cap is refused with scope 'user'", () => {
  const { config, database } = setup({ DEFAULT_MONTHLY_TOKEN_BUDGET: "100" });
  const user = { id: "u1", role: "member", monthlyTokenBudget: null };

  insertUsage(database, { userId: "u1", tokens: 100, createdAt: new Date().toISOString() });

  assert.deepEqual(checkBudget({ database, config, user }), { ok: false, scope: "user" });
  database.close();
});

test("the owner is exempt from the per-user cap but not from the global ceiling", () => {
  const { config, database } = setup({
    DEFAULT_MONTHLY_TOKEN_BUDGET: "10",
    GLOBAL_DAILY_TOKEN_LIMIT: "50",
  });
  const owner = { id: "u1", role: "owner", monthlyTokenBudget: null };

  insertUsage(database, { userId: "u1", tokens: 1000, createdAt: new Date().toISOString() });
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

test("monthStartISO returns the first instant of the current UTC month", () => {
  assert.equal(monthStartISO(new Date("2026-08-31T23:59:59.000Z")), "2026-08-01T00:00:00.000Z");
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server && npm test
```

Expected: FAIL — `Cannot find module '../src/budget.js'`.

- [ ] **Step 3: Write the implementation**

Create `server/src/budget.js`:

```js
import { randomUUID } from "node:crypto";

export function monthStartISO(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

function todayUTC(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

export function effectiveBudget(user, config) {
  const override = user?.monthlyTokenBudget;
  return typeof override === "number" && override >= 0
    ? override
    : config.defaultMonthlyTokenBudget;
}

function tokensUsedThisMonth({ database, user }) {
  const row = database.connection
    .prepare(
      `SELECT COALESCE(SUM(total_tokens), 0) AS total
       FROM usage_events
       WHERE user_id = ? AND created_at >= ?`
    )
    .get(user.id, monthStartISO());

  return Number(row?.total ?? 0);
}

function tokensUsedToday({ database }) {
  const row = database.connection
    .prepare("SELECT tokens FROM daily_budget WHERE date = ?")
    .get(todayUTC());

  return Number(row?.tokens ?? 0);
}

export function summarizeUserBudget({ database, config, user }) {
  const tokensUsed = tokensUsedThisMonth({ database, user });
  const tokenBudget = effectiveBudget(user, config);

  return {
    tokensUsed,
    tokenBudget,
    tokensRemaining: Math.max(0, tokenBudget - tokensUsed),
  };
}

/**
 * Pre-flight only. Usage arrives at the end of a stream, so a user's final message can
 * overshoot their cap by one response. Estimating tokens up front would be wrong in both
 * directions; the overshoot is bounded by one message and is accepted.
 */
export function checkBudget({ database, config, user }) {
  if (tokensUsedToday({ database }) >= config.globalDailyTokenLimit) {
    return { ok: false, scope: "global" };
  }

  // The owner is exempt from the per-user cap but is still metered, and is still subject
  // to the global ceiling.
  if (user.role !== "owner" && tokensUsedThisMonth({ database, user }) >= effectiveBudget(user, config)) {
    return { ok: false, scope: "user" };
  }

  return { ok: true };
}

export function recordUsage({ database, usage, user, guest, provider, modelId }) {
  if (!usage) return;

  const total = Number(usage.totalTokenCount ?? 0);
  const now = new Date();

  database.transaction(() => {
    database.connection
      .prepare(
        `INSERT INTO usage_events
           (id, user_id, guest_id, provider, model_id,
            prompt_tokens, completion_tokens, total_tokens, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        randomUUID(),
        user?.id ?? null,
        guest?.guestId ?? null,
        provider ?? "unknown",
        modelId ?? "unknown",
        usage.promptTokenCount ?? null,
        usage.candidatesTokenCount ?? null,
        total || null,
        now.toISOString()
      );

    database.connection
      .prepare(
        `INSERT INTO daily_budget (date, guest_messages, tokens) VALUES (?, 0, ?)
         ON CONFLICT(date) DO UPDATE SET tokens = tokens + excluded.tokens`
      )
      .run(todayUTC(now), total);
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd server && npm test
```

Expected: PASS, 7 new tests.

- [ ] **Step 5: Wire the budget check into the chat stream**

In `POST /api/chat/stream` in `server/src/index.js`, immediately after the guest block from Task 6:

```js
if (request.authUser) {
  const budget = checkBudget({ database, config, user: request.authUser });

  if (!budget.ok) {
    beginSseResponse(response);
    sendSseEvent(response, "error", {
      httpCode: 429,
      googleStatus: null,
      message:
        budget.scope === "user"
          ? "You've used your token budget for this month. Ask Phil to raise it."
          : "The site has hit its daily token ceiling. Try again tomorrow.",
      modelId: request.body?.modelId ?? null,
      provider: null,
      details: { budgetExhausted: true, scope: budget.scope },
    });
    response.end();
    return;
  }
}
```

- [ ] **Step 6: Record usage after the stream**

Track the resolved provider in a variable the `finally` can see, then add to the existing `finally` block, before `response.end()`:

```js
} finally {
  recordUsage({
    database,
    usage: finalUsage,
    user: request.authUser,
    guest,
    provider: resolvedProvider,
    modelId: request.body?.modelId,
  });
  response.end();
}
```

`resolvedProvider` is assigned from the `openProviderChatStream` destructure (`const { provider, response: streamResponse } = ...`); declare `let resolvedProvider = null;` alongside `finalUsage` and set it there. An aborted stream records whatever usage arrived; a stream that reported none records nothing.

- [ ] **Step 7: Replace the `/api/me` stub from Task 5**

Swap the placeholder for the real handler shown in Task 5 Step 5, importing `summarizeUserBudget` from `./budget.js` and `summarizeGuestAllowance` + `resolveGuest` from `./guests.js`. For an anonymous caller, read the guest cookie **without issuing one** — `/api/me` runs on page load, and issuing there would reintroduce the cookie-for-every-visitor behaviour this task removed:

```js
const guest = {
  guestId: request.signedCookies?.philchat_guest ?? null,
  ipHash: hashIp(request.ip, config.sessionSecret),
};
```

`summarizeGuestAllowance` handles a null `guestId` — the IP-based count still applies.

- [ ] **Step 8: Run the full suite**

```bash
cd server && npm test
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add server/src/budget.js server/src/index.js server/test/budget.test.js
git commit -m "$(cat <<'EOF'
Meter tokens per user with a monthly budget and a global daily ceiling

Both providers already normalise usage to the same shape, so accounting
needs no provider changes. Enforcement is check-before, record-after: a
user's last message can overshoot by one response, which is accepted and
documented rather than estimated up front.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Owner-only admin routes

**Files:**
- Rewrite: `server/src/admin.js` (replacing the Task 5 stub)
- Test: `server/test/admin.test.js`

**Interfaces:**
- Consumes: `openDatabase` (Task 2), `createApp` (Task 5), `monthStartISO` (Task 7).
- Produces: `registerAdminRoutes(router, { database, config })`, mounting `GET /api/admin/users`, `POST /api/admin/users/:id/approve`, `POST /api/admin/users/:id/reject`, `PATCH /api/admin/users/:id/budget`.

- [ ] **Step 1: Write the failing test**

Create `server/test/admin.test.js`. It exercises the module directly against a database rather than over HTTP; the 401/403 behaviour is already covered by `routes.test.js`:

```js
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
  insert.run("owner1", "phil", "phil@example.com", "2026-08-01", "2026-08-01", "phil", "owner", "approved");
  insert.run("u1", "alice", "alice@example.com", "2026-08-02", "2026-08-02", "alice", "member", "pending");

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
    .prepare("SELECT COUNT(*) AS count FROM session WHERE \"userId\" = ?")
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server && npm test
```

Expected: FAIL — `listUsers is not exported from ../src/admin.js`.

- [ ] **Step 3: Write the implementation**

Replace `server/src/admin.js` entirely:

```js
import { monthStartISO } from "./budget.js";

function errorPayload(code, message) {
  return { error: { code, message } };
}

/**
 * An explicit column list, never SELECT *: the user table holds fields with no business
 * on the wire, so a column added later must be opted into deliberately.
 */
export function listUsers({ database, config, status }) {
  const rows = database.connection
    .prepare(
      `SELECT u."id", u."username", u."displayUsername", u."email", u."createdAt",
              u."approvalStatus", u."role", u."approvedAt", u."monthlyTokenBudget",
              (SELECT COALESCE(SUM(e.total_tokens), 0)
                 FROM usage_events e
                WHERE e.user_id = u."id" AND e.created_at >= ?) AS tokensUsed
         FROM "user" u
         ${status === "all" ? "" : `WHERE u."approvalStatus" = 'pending'`}
         ORDER BY CASE u."approvalStatus" WHEN 'pending' THEN 0 ELSE 1 END,
                  u."createdAt" DESC`
    )
    .all(monthStartISO());

  return rows.map((row) => ({
    ...row,
    tokensUsed: Number(row.tokensUsed),
    tokenBudget:
      typeof row.monthlyTokenBudget === "number"
        ? row.monthlyTokenBudget
        : config.defaultMonthlyTokenBudget,
  }));
}

export function setApprovalStatus({ database, id, status, actorId }) {
  const target = database.connection
    .prepare('SELECT "id", "role" FROM "user" WHERE "id" = ?')
    .get(id);

  if (!target) {
    return { ok: false, code: "NOT_FOUND" };
  }

  // The owner cannot lock themselves out of their own admin panel.
  if (target.role === "owner") {
    return { ok: false, code: "CONFLICT" };
  }

  database.transaction(() => {
    database.connection
      .prepare(
        `UPDATE "user" SET "approvalStatus" = ?, "approvedAt" = ?, "approvedBy" = ?
         WHERE "id" = ?`
      )
      .run(status, new Date().toISOString(), actorId ?? null, id);

    // Revocation is the whole point of server-side sessions: a rejected user's live
    // session dies now rather than lasting until its token happens to expire.
    if (status === "rejected") {
      database.connection.prepare('DELETE FROM session WHERE "userId" = ?').run(id);
    }
  });

  return { ok: true, id, approvalStatus: status };
}

export function setUserBudget({ database, id, monthlyTokenBudget }) {
  const target = database.connection
    .prepare('SELECT "id" FROM "user" WHERE "id" = ?')
    .get(id);

  if (!target) {
    return { ok: false, code: "NOT_FOUND" };
  }

  database.connection
    .prepare(`UPDATE "user" SET "monthlyTokenBudget" = ? WHERE "id" = ?`)
    .run(monthlyTokenBudget, id);

  return { ok: true, id, monthlyTokenBudget };
}

/**
 * Owner-only. The default-deny middleware in index.js already turns anonymous callers
 * away, so this only has to separate a member from the owner.
 */
function requireOwner(request, response) {
  if (request.isOwner) return true;
  response.status(403).json(errorPayload("FORBIDDEN", "Owner access required."));
  return false;
}

export function registerAdminRoutes(router, { database, config }) {
  router.get("/api/admin/users", (request, response) => {
    if (!requireOwner(request, response)) return;

    const status = request.query.status === "all" ? "all" : "pending";
    response.json({ users: listUsers({ database, config, status }) });
  });

  const setStatusRoute = (status) => (request, response) => {
    if (!requireOwner(request, response)) return;

    const result = setApprovalStatus({
      database,
      id: request.params.id,
      status,
      actorId: request.authUser?.id ?? null,
    });

    if (result.ok) {
      response.json(result);
      return;
    }

    response
      .status(result.code === "NOT_FOUND" ? 404 : 409)
      .json(
        errorPayload(
          result.code,
          result.code === "NOT_FOUND" ? "User not found." : "The owner cannot be changed."
        )
      );
  };

  router.post("/api/admin/users/:id/approve", setStatusRoute("approved"));
  router.post("/api/admin/users/:id/reject", setStatusRoute("rejected"));

  router.patch("/api/admin/users/:id/budget", (request, response) => {
    if (!requireOwner(request, response)) return;

    const raw = request.body?.monthlyTokenBudget;
    const parsed = raw === null || raw === undefined ? null : Number(raw);

    if (parsed !== null && (!Number.isInteger(parsed) || parsed < 0)) {
      response
        .status(400)
        .json(errorPayload("BAD_REQUEST", "monthlyTokenBudget must be a non-negative integer or null."));
      return;
    }

    const result = setUserBudget({ database, id: request.params.id, monthlyTokenBudget: parsed });

    if (result.ok) {
      response.json(result);
      return;
    }

    response.status(404).json(errorPayload("NOT_FOUND", "User not found."));
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd server && npm test
```

Expected: PASS, 6 new tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/admin.js server/test/admin.test.js
git commit -m "$(cat <<'EOF'
Add owner-only user administration routes

Approve, reject and set a per-user token budget. Rejecting deletes the
user's session rows so access ends now rather than when the token happens
to expire. The owner row cannot be rejected.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Auth client and the auth modal

**Files:**
- Create: `webui/src/lib/authClient.js`, `webui/src/components/AuthModal.jsx`
- Delete: `webui/src/components/LoginModal.jsx`
- Modify: `webui/src/lib/api.js`, `webui/src/App.jsx`, `webui/package.json`

**Interfaces:**
- Consumes: `/api/auth/*` (Task 5), `/api/me` (Task 7).
- Produces: `authClient` with `signIn.username`, `signUp.email`, `signOut`; `<AuthModal onClose mode initialNotice />`.

- [ ] **Step 1: Install the client**

```bash
cd webui && npm install better-auth
```

- [ ] **Step 2: Create the auth client**

`webui/src/lib/authClient.js`:

```js
import { usernameClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

// Same origin as the app, so no baseURL is needed.
export const authClient = createAuthClient({
  plugins: [usernameClient()],
});
```

- [ ] **Step 3: Write `AuthModal.jsx`**

Keep the existing modal's Tailwind classes so it matches the app; the change is the tabs and the notice states.

```jsx
/* eslint-disable react/prop-types */
import { useState } from "react";

import { authClient } from "../lib/authClient";

const NOTICES = {
  guestLimit: {
    title: "Guest limit reached",
    body: "You've used all your guest messages. Create an account to keep going — Phil approves new accounts by hand.",
  },
  budget: {
    title: "Token budget used up",
    body: "You've used your token budget for this month. Ask Phil to raise it.",
  },
  pending: {
    title: "Waiting for approval",
    body: "Your account exists but is waiting to be approved. You'll be able to sign in once it is.",
  },
};

export default function AuthModal({ onClose, onSignedIn, initialNotice = null, dismissable = true }) {
  const [mode, setMode] = useState("signIn");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [notice, setNotice] = useState(initialNotice);
  const [error, setError] = useState(null);
  const [isLoading, setIsLoading] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setIsLoading(true);
    setError(null);

    try {
      if (mode === "signUp") {
        const { error: signUpError } = await authClient.signUp.email({
          email: email.trim(),
          name: username.trim(),
          username: username.trim(),
          password,
        });

        if (signUpError) throw new Error(signUpError.message);

        setMode("signIn");
        setNotice("pending");
        setPassword("");
        return;
      }

      const { error: signInError } = await authClient.signIn.username({
        username: username.trim(),
        password,
      });

      if (signInError) {
        // The approval gate answers with these codes; anything else is a bad credential.
        if (signInError.code === "ACCOUNT_PENDING") {
          setNotice("pending");
          return;
        }
        if (signInError.code === "ACCOUNT_REJECTED") {
          setError("This account cannot sign in.");
          return;
        }
        throw new Error(signInError.message);
      }

      await onSignedIn();
    } catch (caught) {
      setError(caught.message || "Something went wrong.");
    } finally {
      setIsLoading(false);
    }
  }

  const activeNotice = notice ? NOTICES[notice] : null;
  const inputClass =
    "w-full rounded-2xl border border-white/10 bg-[#222222] px-4 py-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-white/20 disabled:opacity-50";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={dismissable ? onClose : undefined}
    >
      <div
        className="w-full max-w-[400px] rounded-[28px] border border-white/10 bg-[#171717] px-6 py-7 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        {activeNotice && (
          <div className="mb-5 rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
            <p className="font-semibold">{activeNotice.title}</p>
            <p className="mt-1 text-amber-200/80">{activeNotice.body}</p>
          </div>
        )}

        <div className="mb-5 flex gap-2">
          {["signIn", "signUp"].map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => { setMode(value); setError(null); }}
              className={`flex-1 rounded-2xl py-2 text-xs uppercase tracking-[0.2em] transition ${
                mode === value
                  ? "bg-zinc-200 text-zinc-950"
                  : "border border-white/10 bg-white/5 text-zinc-400 hover:bg-white/10"
              }`}
            >
              {value === "signIn" ? "Sign in" : "Sign up"}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <input
            type="text"
            placeholder="Username"
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            disabled={isLoading}
            className={inputClass}
          />

          {mode === "signUp" && (
            <input
              type="email"
              placeholder="Email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={isLoading}
              className={inputClass}
            />
          )}

          <input
            type="password"
            placeholder={mode === "signUp" ? "Password (12+ characters)" : "Password"}
            autoComplete={mode === "signUp" ? "new-password" : "current-password"}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={isLoading}
            className={inputClass}
          />

          {error && (
            <p className="rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={isLoading || !username.trim() || !password || (mode === "signUp" && !email.trim())}
            className="w-full rounded-2xl bg-zinc-200 py-3 text-sm font-medium text-zinc-950 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isLoading ? "Working…" : mode === "signUp" ? "Create account" : "Sign in"}
          </button>
        </form>

        {mode === "signUp" && (
          <p className="mt-3 text-center text-xs text-zinc-500">
            New accounts are approved by hand before they can sign in.
          </p>
        )}

        {dismissable && (
          <button
            type="button"
            onClick={onClose}
            className="mt-3 w-full rounded-2xl border border-white/10 bg-white/5 py-3 text-sm text-zinc-400 transition hover:bg-white/10"
          >
            Continue as guest
          </button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Update `webui/src/lib/api.js`**

Delete the `login` and `logout` exports (Better Auth owns them now) and add:

```js
export function fetchAdminUsers(status = "pending") {
  return fetchJson(apiPath(`/api/admin/users?status=${status}`));
}

export function setUserApproval(id, approved) {
  return fetchJson(apiPath(`/api/admin/users/${id}/${approved ? "approve" : "reject"}`), {
    method: "POST",
  });
}

export function setUserBudget(id, monthlyTokenBudget) {
  return fetchJson(apiPath(`/api/admin/users/${id}/budget`), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ monthlyTokenBudget }),
  });
}
```

- [ ] **Step 5: Swap the modal in `App.jsx`**

Replace the `LoginModal` import with `AuthModal`, rename `showLoginModal` → `showAuthModal` and `loginLimitReached` → `authNotice` (holding `null | "guestLimit" | "budget" | "pending"`). Replace `handleLogin`/`handleLogout`:

```js
async function handleSignedIn() {
  setShowAuthModal(false);
  setAuthNotice(null);
  setTopError(null);
  const meData = await fetchMe();
  applyMe(meData);
}

async function handleLogout() {
  try {
    await authClient.signOut();
  } catch {
    // ignore
  }
  const meData = await fetchMe();
  applyMe(meData);
}
```

with a single `applyMe` helper replacing the inline `meData.authenticated` branch in `initializeApp`:

```js
function applyMe(meData) {
  if (meData.authenticated) {
    setAuthUser(meData.user);
    setUserUsage(meData.usage);
    setPendingUserCount(meData.pendingUserCount ?? 0);
    setGuestAllowance(null);
    return;
  }

  setAuthUser(null);
  setUserUsage(null);
  setPendingUserCount(0);
  setGuestAllowance(meData.guest);
}
```

Delete the now-unused `authEnabled`, `guestMessagesUsed` and `guestMessagesLimit` state; add `userUsage`, `guestAllowance` and `pendingUserCount`.

- [ ] **Step 6: Delete the old modal**

```bash
git rm webui/src/components/LoginModal.jsx
```

- [ ] **Step 7: Verify the build and lint**

```bash
cd .. && npm run lint && npm run build
```

Expected: PASS with no unused-variable errors from the removed state.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Replace the login modal with sign-in and sign-up

Adds explicit pending-approval, guest-limit and budget-exhausted states.
The old copy promised "unlimited access" on sign-in, which budgets make
untrue.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Surface allowances in the UI

**Files:**
- Modify: `webui/src/App.jsx`

**Interfaces:**
- Consumes: `applyMe`, `guestAllowance`, `userUsage` (Task 9); `details.budgetExhausted`, `details.limitReached`, `details.modelNotAllowed` on the SSE error event (Tasks 6–7).
- Produces: no new exports.

- [ ] **Step 1: Show what is left**

Replace the guest banner near line 1564 (the `authEnabled && !authUser` block) with one that reads from the new state:

```jsx
{guestAllowance && (
  <div className="flex items-center justify-center gap-3 border-b border-white/5 bg-white/5 px-4 py-2 text-xs text-zinc-400">
    <span>
      {guestAllowance.messagesRemaining} of {guestAllowance.messagesLimit} guest messages left
    </span>
    <button
      type="button"
      onClick={() => { setAuthNotice(null); setShowAuthModal(true); }}
      className="rounded-xl border border-white/10 bg-white/5 px-3 py-1 text-zinc-300 transition hover:bg-white/10"
    >
      Sign in
    </button>
  </div>
)}

{userUsage && (
  <span className="text-xs text-zinc-500">
    {userUsage.tokensRemaining.toLocaleString()} tokens left this month
  </span>
)}
```

- [ ] **Step 2: Route stream errors to the right notice**

Where the SSE `error` event is handled, replace the existing limit check with:

```js
if (payload.details?.limitReached || payload.details?.dailyLimitReached) {
  setAuthNotice("guestLimit");
  setShowAuthModal(true);
  return;
}

if (payload.details?.budgetExhausted) {
  setAuthNotice(payload.details.scope === "user" ? "budget" : null);
  if (payload.details.scope === "user") setShowAuthModal(true);
  // A global ceiling is not something signing in fixes; show it as a top error instead.
  else setTopError({ title: "Daily limit reached", message: payload.message });
  return;
}
```

- [ ] **Step 3: Filter the model picker for guests**

`/api/models` returns every model. When `guestAllowance` is set and the server advertises an allowlist, hide the rest. Add `guestModelAllowlist` to the `/api/bootstrap` payload in `server/src/config.js`'s `buildBootstrapPayload` (it is public, and a list of permitted model ids is not sensitive), then in `App.jsx`:

```js
const visibleModels = useMemo(() => {
  const allowlist = bootstrap?.guestModelAllowlist ?? [];
  if (authUser || allowlist.length === 0) return models;
  return models.filter((model) => allowlist.includes(model.id));
}, [models, bootstrap, authUser]);
```

and render `visibleModels` in the picker. The server-side refusal from Task 6 stays as the backstop.

- [ ] **Step 4: Verify the build**

```bash
npm run lint && npm run build
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Show remaining guest messages and monthly tokens in the UI

Stream errors now route to the notice that matches the reason, and guests
only see models they are allowed to use — the server-side refusal stays as
the backstop.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Admin panel

**Files:**
- Create: `webui/src/components/AdminPanel.jsx`
- Modify: `webui/src/App.jsx`

**Interfaces:**
- Consumes: `fetchAdminUsers`, `setUserApproval`, `setUserBudget` (Task 9).
- Produces: `<AdminPanel onClose />`.

- [ ] **Step 1: Write the panel**

```jsx
/* eslint-disable react/prop-types */
import { useCallback, useEffect, useState } from "react";

import { fetchAdminUsers, setUserApproval, setUserBudget } from "../lib/api";

export default function AdminPanel({ onClose }) {
  const [users, setUsers] = useState([]);
  const [status, setStatus] = useState("pending");
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async (nextStatus) => {
    try {
      const payload = await fetchAdminUsers(nextStatus);
      setUsers(payload.users);
      setError(null);
    } catch (caught) {
      setError(caught.message);
    }
  }, []);

  useEffect(() => { void load(status); }, [load, status]);

  async function act(id, action) {
    setBusyId(id);
    try {
      await action();
      await load(status);
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="max-h-[80vh] w-full max-w-[640px] overflow-y-auto rounded-[28px] border border-white/10 bg-[#171717] px-6 py-7 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-5 flex items-center justify-between">
          <p className="text-xs uppercase tracking-[0.28em] text-zinc-500">Accounts</p>
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            className="rounded-xl border border-white/10 bg-[#222222] px-3 py-1.5 text-xs text-zinc-300"
          >
            <option value="pending">Pending</option>
            <option value="all">All</option>
          </select>
        </div>

        {error && (
          <p className="mb-4 rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            {error}
          </p>
        )}

        {users.length === 0 && (
          <p className="py-8 text-center text-sm text-zinc-500">Nothing waiting.</p>
        )}

        <ul className="space-y-3">
          {users.map((user) => (
            <li key={user.id} className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm text-zinc-100">
                    {user.username}
                    <span className="ml-2 text-xs text-zinc-500">{user.email}</span>
                  </p>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    {user.approvalStatus} · {user.tokensUsed.toLocaleString()} /{" "}
                    {user.tokenBudget.toLocaleString()} tokens this month
                  </p>
                </div>

                {user.role !== "owner" && (
                  <div className="flex shrink-0 gap-2">
                    <button
                      type="button"
                      disabled={busyId === user.id || user.approvalStatus === "approved"}
                      onClick={() => act(user.id, () => setUserApproval(user.id, true))}
                      className="rounded-xl bg-emerald-500/15 px-3 py-1.5 text-xs text-emerald-300 disabled:opacity-40"
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      disabled={busyId === user.id || user.approvalStatus === "rejected"}
                      onClick={() => act(user.id, () => setUserApproval(user.id, false))}
                      className="rounded-xl bg-red-500/15 px-3 py-1.5 text-xs text-red-300 disabled:opacity-40"
                    >
                      Reject
                    </button>
                  </div>
                )}
              </div>

              {user.role !== "owner" && (
                <form
                  className="mt-3 flex gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const raw = new FormData(event.currentTarget).get("budget");
                    const value = String(raw).trim();
                    void act(user.id, () =>
                      setUserBudget(user.id, value === "" ? null : Number(value))
                    );
                  }}
                >
                  <input
                    name="budget"
                    type="number"
                    min="0"
                    step="1000"
                    placeholder={`default (${user.tokenBudget.toLocaleString()})`}
                    defaultValue={user.monthlyTokenBudget ?? ""}
                    className="flex-1 rounded-xl border border-white/10 bg-[#222222] px-3 py-1.5 text-xs text-zinc-200"
                  />
                  <button
                    type="submit"
                    disabled={busyId === user.id}
                    className="rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-zinc-300 disabled:opacity-40"
                  >
                    Set budget
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>

        <button
          type="button"
          onClick={onClose}
          className="mt-5 w-full rounded-2xl border border-white/10 bg-white/5 py-3 text-sm text-zinc-400 transition hover:bg-white/10"
        >
          Close
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Mount it, owner-only**

In `App.jsx`, add `const [showAdmin, setShowAdmin] = useState(false);`, render the trigger only when `authUser?.role === "owner"` (with the `pendingUserCount` badge), and render `{showAdmin && <AdminPanel onClose={() => setShowAdmin(false)} />}` alongside the auth modal. The panel must be **absent for a member, not merely hidden** — gate on the role at the JSX level, not with CSS.

- [ ] **Step 3: Verify the build**

```bash
npm run lint && npm run build
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Add the owner-only admin panel

Approve or reject pending accounts and override a user's monthly token
budget, with month-to-date consumption alongside each account.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Cutover

> **Amended during execution.** This task was planned around the existing GitHub Actions
> deploy. That deploy turned out to have been broken since the Hetzner migration -
> `SERVER_HOST` resolves to a host that is not the box, so every push had been failing at
> `ssh-keyscan` and the running container had been placed by hand. Rather than repair a
> pipeline needing standing SSH access to the server, philchat moved to **Coolify**,
> matching the other apps on the box.
>
> What shipped instead of steps 2-4 below:
>
> - Coolify application `philchat` (`ciyrvfog75gpwtdizox0ydlh`), public repo, `main`,
>   Dockerfile build pack, port 8791, domain `https://chat.philippeho.dev`
> - Persistent storage `type: "persistent"`, `/home/phil/app-data/philchat` -> `/data`,
>   matching personal-soundcloud
> - 17 environment variables set through the Coolify API; Coolify's automatic preview
>   duplicates were deleted so each secret exists once
> - The `Dockerfile` became multi-stage so it builds the web UI itself - `webui/dist` is
>   gitignored, so a build from a clean clone would otherwise ship an empty UI. It needs
>   `npm ci --include=dev`, because Coolify passes env vars through as build args and
>   `NODE_ENV=production` would otherwise skip vite.
> - `.github/workflows/deploy.yml` became `ci.yml`: tests, lint and an image build, no
>   deploy and no SSH. `docker-compose.yml` and `ecosystem.config.cjs` were deleted, having
>   described the manual stack and PM2 respectively.
> - The manual stack was retired to `/opt/philchat.retired-20260901` rather than deleted,
>   and the manual Traefik router removed. `philchat-redirect.yaml` stays - Coolify does
>   not generate the legacy 301.
>
> Steps 1 and 5-7 below still applied. Releases are manual: a push to `main` runs CI but
> does not deploy.

**Files:**
- Modify: `.env.example`, `README.md`
- Modify (on the server, manually): `/opt/philchat/docker-compose.yml`, `/opt/philchat/.env`

**Interfaces:**
- Consumes: everything above.
- Produces: philchat running on Better Auth in production.

- [ ] **Step 1: Update `.env.example` and the README**

`.env.example` gains the full new surface and loses the old one:

```bash
# Required. The server refuses to start without these.
PUBLIC_ORIGIN=https://chat.philippeho.dev
SESSION_SECRET=
OWNER_EMAIL=
OWNER_PASSWORD=

# First-boot seed only; ignored once an owner row exists.
OWNER_USERNAME=phil

PHILCHAT_DB_PATH=/data/philchat.sqlite

GUEST_MESSAGE_LIMIT=5
GUEST_DAILY_MESSAGE_LIMIT=50
GUEST_MODEL_ALLOWLIST=

DEFAULT_MONTHLY_TOKEN_BUDGET=500000
GLOBAL_DAILY_TOKEN_LIMIT=2000000
```

Delete `ADMIN_PASSWORD`, `ADMIN_USERNAME`, `EXTRA_USERS`, `PUBLIC_MESSAGE_LIMIT`, `PUBLIC_DAILY_LIMIT`, `APP_BASE_PATH`, `VITE_BASE_PATH`. Update the README's Notes section to describe accounts and approval rather than a shared password.

- [ ] **Step 2: Add the volume mount (server, manual, before deploying)**

```bash
ssh -i ~/.ssh/hetzner_ed25519 phil@95.217.6.255
sudo mkdir -p /home/phil/app-data/philchat
sudo chown phil:phil /home/phil/app-data/philchat
```

Then add to the `philchat` service in `/opt/philchat/docker-compose.yml`:

```yaml
    volumes:
      - /home/phil/app-data/philchat:/data
```

- [ ] **Step 3: Rewrite `/opt/philchat/.env` (server, manual)**

Generate the secret and a strong owner password:

```bash
openssl rand -hex 32
openssl rand -base64 24
```

Delete `ADMIN_PASSWORD`, `ADMIN_USERNAME`, `EXTRA_USERS` and `APP_BASE_PATH` from the file; add every variable from Step 1 with real values. Store the owner password in the password manager — it is used once and then ignored for ever.

> Deleting `ADMIN_PASSWORD` is what closes the audit's "confirmed live 4-digit password" finding: the code path that read it is gone, so the value cannot come back by being reset to something short later.

- [ ] **Step 4: Merge and deploy**

```bash
git checkout main && git merge philchat-auth && git push
```

The workflow runs `npm test` and `npm run lint` before deploying; a failure there stops the deploy.

- [ ] **Step 5: Verify in production**

Traefik returns 503 for 30–60s after a redeploy — poll rather than concluding failure.

```bash
# The app is up
curl -sSI https://chat.philippeho.dev/ | head -1

# Anonymous callers are refused on protected routes
curl -sS -o /dev/null -w '%{http_code}\n' https://chat.philippeho.dev/api/admin/users   # 401
curl -sS -o /dev/null -w '%{http_code}\n' https://chat.philippeho.dev/api/usage         # 401

# The session cookie has the __Host- prefix
curl -sS -i -X POST https://chat.philippeho.dev/api/auth/sign-in/username \
  -H 'Content-Type: application/json' -H 'Origin: https://chat.philippeho.dev' \
  -d '{"username":"phil","password":"<owner password>"}' | grep -i set-cookie
```

Expected on the last: `set-cookie: __Host-philchat_session=...; Path=/; HttpOnly; Secure; SameSite=Strict`.

Then in a browser: sign up a throwaway account, confirm it cannot sign in, approve it from the admin panel, confirm it can, reject it, and confirm its session dies on the next request. Confirm the database file exists:

```bash
ssh -i ~/.ssh/hetzner_ed25519 phil@95.217.6.255 'ls -la /home/phil/app-data/philchat/'
```

- [ ] **Step 6: Confirm the old secrets are gone**

```bash
ssh -i ~/.ssh/hetzner_ed25519 phil@95.217.6.255 \
  'sudo docker exec philchat printenv | grep -c -E "^(ADMIN_PASSWORD|ADMIN_USERNAME|EXTRA_USERS)=" || echo 0'
```

Expected: `0`.

- [ ] **Step 7: Commit the documentation changes**

```bash
git add .env.example README.md
git commit -m "$(cat <<'EOF'
Document the new auth environment and remove the old secrets

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-review notes

**Spec coverage:** Phase 0 → Task 1. Phase 1 → Task 2. Phase 2 → Tasks 3–4. Phase 3 → Task 6. Phase 4 → Task 7. Phase 5 → Tasks 5 and 8. Phase 6 → Tasks 9–11. Testing section → tests inside Tasks 2, 3, 4, 5, 6, 7, 8. Deployment section → Task 12.

**Known ordering constraint:** Task 5 mounts `registerAdminRoutes` before Task 8 writes it, so Task 5 Step 7 creates a no-op stub. Task 5 similarly stubs `/api/me`, which Task 7 Step 7 replaces once `summarizeUserBudget` and `summarizeGuestAllowance` exist. Both are called out in place; do not skip them or the intermediate task will not run.

**Deliberately out of scope**, per the spec: MFA, Cloudflare Access, chat history persistence, password reset by email, and the fleet's other three 4-digit passwords.
