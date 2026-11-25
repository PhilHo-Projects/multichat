-- Rollback for migration 3 (server/src/database.js), which dropped account.issuer.
-- Only needed to run better-auth 1.7.0-1.7.2 again. Stop the app, run this against the
-- database, then deploy the commit that pins better-auth 1.7.2.
-- Every account 1.7.2 wrote was local, with issuer = 'local:' || providerId.
BEGIN;
ALTER TABLE "account" ADD COLUMN "issuer" text;
UPDATE "account" SET "issuer" = 'local:' || "providerId";
CREATE UNIQUE INDEX "account_issuer_accountId_uidx" ON "account" ("issuer", "accountId");
DELETE FROM schema_migrations WHERE version = 3;
COMMIT;
