import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Better Auth's own tables come first. Its identifiers are camelCase and double-quoted
 * while ours are snake_case; both are correct. `user` is a SQL reserved word, so it must
 * stay quoted everywhere it appears.
 *
 * The `issuer` column on `account` is not optional. Better Auth 1.7 writes to it, and
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
