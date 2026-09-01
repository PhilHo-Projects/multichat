# philchat auth rebuild — design

**Date:** 2026-08-31
**Status:** approved, ready for implementation planning
**Repo:** `PhilHo-Projects/multichat` (deployed as `philchat`)

## Why

The 31 Aug 2026 fleet auth re-audit scored philchat **2/10, the worst of 22 apps** and the
only one still rated Critical. The findings, confirmed against the code in this repo:

| Finding | Location |
| --- | --- |
| `ADMIN_PASSWORD` compared with `===`; live value is 4 digits, numeric | `server/src/auth.js` `verifyCredentials` |
| `EXTRA_USERS` JSON env blob takes the same plaintext path | `server/src/auth.js` |
| `SESSION_SECRET \|\| "dev-secret-change-in-production"` | `server/src/index.js` |
| No throttle of any kind on `/api/login` | `server/src/index.js` |
| Guest limits are in-process; they reset to zero on every deploy | `server/src/auth.js` `dailyBucket` |
| `saveUninitialized: true` issues a session cookie to every visitor | `server/src/index.js` |
| No database, so nothing is revocable and nothing survives a restart | — |
| Session cookie shares the apex jar with portfolio, Billing Hub, PowerTree | `philippeho.dev/philchat` |
| `/api/usage` exposes Google Cloud project quota to anyone | `server/src/index.js` |

The goal is not to patch these individually. It is to replace the auth subsystem with the
pattern already proven twice on this fleet — manga-tracker and personal-soundcloud
(cloudsong), both scored 8/10 — and to add the two things philchat needs that neither of
those has: a **public guest trial** and **per-user token budgets** over metered upstream
APIs.

## Product shape

- Anyone can use the chat for a small number of messages without an account.
- Anyone can sign up. A new account lands in `pending` and can never hold a session.
- The owner approves accounts. Approved users chat against the owner's Google and NVIDIA
  API keys, capped by a per-user monthly token budget, under a global daily ceiling.
- The owner sees pending accounts, per-user token consumption, and can raise or lower an
  individual budget.

## Reference implementation

cloudsong (`personal-soundcloud`, `cloudsound.philippeho.dev`) is the house pattern and
should be copied rather than reinvented. Its source is not checked out on disk; read the
compiled output inside the running container:

```bash
ssh -i ~/.ssh/hetzner_ed25519 phil@95.217.6.255
sudo docker exec mpo5318hub8qoa2pwzasgebp-234721419828 sh -lc 'cat dist/server/auth.js'
```

Files worth reading before writing any code: `dist/server/auth.js` (Better Auth config),
`dist/server/owner.js` (first-boot seed), `dist/server/admin.js` (approve/reject),
`dist/server/app.js` (default-deny hook, origin check, Better Auth mounting),
`dist/server/database.js` (migration runner and Better Auth DDL).

Deltas from cloudsong, and only these: philchat is Express 5 rather than Fastify, has an
anonymous guest tier cloudsong has no concept of, meters tokens rather than storage bytes,
and validates env by hand rather than with zod (philchat has no zod dependency and its
existing `config.js` is hand-rolled — match the surrounding code).

---

## Phase 0 — Move to `chat.philippeho.dev`

**This ships and is verified on its own, before any auth code is written.** It is what
makes a `__Host-` cookie possible (that prefix requires `Path=/` and no `Domain`) and what
gets other people's session cookies out of a jar shared with three unrelated apps. Doing it
after the rewrite means redoing the cookie work.

1. Cloudflare DNS: `chat.philippeho.dev` A → `95.217.6.255`, **DNS-only** (not proxied),
   matching every other subdomain on the box.
2. Rewrite `/data/coolify/proxy/dynamic/philchat.yaml` — routers keyed on
   ``Host(`chat.philippeho.dev`)``, same `philchat:8791` service, `letsencrypt` resolver.
3. Add `/data/coolify/proxy/dynamic/philchat-redirect.yaml`, copying
   `manga-tracker-redirect.yaml` verbatim: priority 1000, `noop@internal` service, a
   `redirectRegex` middleware with `permanent: true` from
   `^https?://philippeho\.dev/philchat(?:[/?].*)?$` → `https://chat.philippeho.dev`.
4. Delete `APP_BASE_PATH` from `Dockerfile`, `docker-compose.yml`, and
   `ecosystem.config.cjs`; delete `VITE_BASE_PATH` from `.github/workflows/deploy.yml` and
   `.env.example`. `normalizeAppBasePath` and the base-path branch at the bottom of
   `index.js` go with them, as does the `README.md` section describing "the AWS path
   deploy".
5. Verify: `chat.philippeho.dev` serves the app, `philippeho.dev/philchat` 301s to it, and
   assets load without a base path.

**Acceptance:** both URLs behave as above before Phase 1 begins.

---

## Phase 1 — Data layer

### Runtime

`Dockerfile` moves `node:22-alpine` → `node:24-alpine`. `node:sqlite` is what cloudsong
runs in production on Node 24, and it avoids a native `better-sqlite3` build in an alpine
image.

### Persistent storage

SQLite lives outside the repo, per house convention:

```yaml
# /opt/philchat/docker-compose.yml  (manual, one-time, on the server)
volumes:
  - /home/phil/app-data/philchat:/data
```

`PHILCHAT_DB_PATH` defaults to `/data/philchat.sqlite`. The directory is created with
`mkdirSync(dirname(path), { recursive: true })` on boot.

### `server/src/database.js` (new)

Owns the connection and the migrations. Constructor: `new DatabaseSync(path)`, then
`PRAGMA foreign_keys = ON`, `PRAGMA journal_mode = WAL`, then `migrate()`.

`migrate()` is cloudsong's runner, copied: a `schema_migrations(version, applied_at)`
table, an ordered `MIGRATIONS` array, each step run inside `BEGIN IMMEDIATE` with its
version recorded **in the same transaction**, so a crash leaves the database at the last
fully applied version rather than half-migrated.

**Migration 1 — Better Auth core tables.** Copy the DDL from cloudsong's migration 3
exactly: `user`, `session`, `account`, `verification`, `rateLimit`, plus the
`session_userId_idx`, `account_userId_idx`, `verification_identifier_idx` and
`account_issuer_accountId_uidx` indexes. Identifiers are camelCase and double-quoted;
`"user"` is a SQL reserved word and must stay quoted everywhere.

> The `account` table **must** include the `"issuer" text NOT NULL` column. Better Auth
> 1.7 requires it, and hand-written DDL that omits it fails at runtime with
> `table account has no column named issuer` on the first sign-up. cloudsong carries a
> comment about exactly this.

`"user"` additionally carries philchat's server-owned columns:
`"role" text NOT NULL`, `"approvalStatus" text NOT NULL`, `"approvedAt" text`,
`"approvedBy" text`, `"monthlyTokenBudget" integer`.

**Migration 2 — philchat tables.**

```sql
CREATE TABLE usage_events (
  id            TEXT NOT NULL PRIMARY KEY,
  user_id       TEXT REFERENCES "user"("id") ON DELETE SET NULL,
  guest_id      TEXT,
  provider      TEXT NOT NULL,
  model_id      TEXT NOT NULL,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  total_tokens      INTEGER,
  created_at    TEXT NOT NULL
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
  date           TEXT NOT NULL PRIMARY KEY,   -- UTC YYYY-MM-DD
  guest_messages INTEGER NOT NULL DEFAULT 0,
  tokens         INTEGER NOT NULL DEFAULT 0
);
```

`user_id` is `ON DELETE SET NULL` deliberately: deleting an account must not erase the
spend history that justified the budget.

**Acceptance:** running the server twice against a fresh file applies migrations once and
is a no-op the second time; a deliberately failing migration leaves `schema_migrations`
unchanged.

---

## Phase 2 — Better Auth

### `server/src/auth.js` — deleted and rewritten

Everything currently in this file goes: `verifyCredentials`, `isAuthEnabled`,
`ADMIN_PASSWORD`, `ADMIN_USERNAME`, `EXTRA_USERS`, the `$2` bcrypt branch, the plaintext
`===` branch, and the in-memory `dailyBucket`. `bcryptjs` and `express-session` are removed
from `server/package.json`. `better-auth` is added. **No second auth path survives** — that
is the property that closes the audit finding, not a stronger value in the same variable.

`buildAuth({ connection, config })` returns `betterAuth({ ... })` mirroring cloudsong:

- `database: connection`, `secret: config.sessionSecret`, `baseURL: config.publicOrigin`,
  `trustedOrigins: [config.publicOrigin.replace(/\/$/, '')]`
- `emailAndPassword`: `enabled: true`, **`autoSignIn: false`**, `minPasswordLength: 12`,
  `requireEmailVerification: false` — the address is collected but never verified; the
  owner's approval is the human check, so there is no SMTP dependency anywhere
- `session.expiresIn`: 30 days
- `user.additionalFields`, every one `input: false` so Better Auth strips them from any
  request body and a sign-up POST carrying `"role":"owner"` cannot escalate:
  - `role` — `string`, required, default `'member'`
  - `approvalStatus` — `string`, required, default `'pending'`
  - `approvedAt`, `approvedBy` — `string`, optional
  - `monthlyTokenBudget` — `number`, optional; `null` means "use the configured default"
- `databaseHooks.session.create.before` — **the approval gate, and the only one in the
  codebase.** Reads `approvalStatus` for `session.userId`; throws
  `APIError('FORBIDDEN', { code: 'ACCOUNT_PENDING' })` for pending and
  `ACCOUNT_REJECTED` for anything not `approved`. Because it sits at session creation, the
  existence of a session proves approval — no downstream route re-checks and there is no
  half-authenticated state for an authorization bug to hide in.
- `rateLimit`: `enabled: true`, `storage: 'database'` (counters survive deploys, unlike an
  in-process limiter), `window: 60`, `max: 100`, with
  `'/sign-in/username'` and `'/sign-in/email'` at 5 per 15 min and `'/sign-up/email'` at
  3 per hour
- `advanced`: `useSecureCookies: false` with `defaultCookieAttributes`
  `{ httpOnly: true, sameSite: 'strict', path: '/', secure: isProduction }`, and
  `cookies.session_token.name` = `'__Host-philchat_session'` in production,
  `'philchat_session'` otherwise

> `useSecureCookies: true` would emit `__Secure-__Host-philchat_session`, which browsers
> read as a plain `__Secure-` cookie — silently losing the guarantee. Setting `secure`
> explicitly and leaving the flag false is the only way to get a literal `__Host-` name.

- `plugins: [username({ minUsernameLength: 3, maxUsernameLength: 30 })]`

### `server/src/owner.js` (new)

`ensureOwner({ auth, connection, config, log })`, copied from cloudsong. If a row with
`role = 'owner'` exists, return its id and do nothing else. Otherwise create the account
through `auth.api.signUpEmail` — so the credential hash format is identical to every other
account's rather than a second thing to keep in step — then promote it with an `UPDATE` to
`role = 'owner'`, `approvalStatus = 'approved'`, `approvedAt = now`.

The `OWNER_*` variables are a **bootstrap, never a standing back door**: once an owner row
exists they are ignored on every subsequent boot. Recovery is a deliberate script run
against the SQLite file over SSH.

### Config and the end of insecure fallbacks

`server/src/config.js` gains env validation in its existing hand-rolled style (no zod). The
server **throws on boot** — a loud failure rather than a silent default — if:

- `SESSION_SECRET` is missing or shorter than 32 characters
- `PUBLIC_ORIGIN` is missing, is not a valid URL, or carries a path
- `OWNER_EMAIL` / `OWNER_PASSWORD` are missing **and** no owner row exists yet
  (`OWNER_PASSWORD` minimum 12, matching the sign-up floor — the owner must not be the
  weakest account on the site)

Every `|| 'dev-secret-change-in-production'` and equivalent is deleted. This is audit item
04, and the reason it matters here is that all four of the fleet's 4-digit passwords
survived two weeks precisely because nothing forced the issue.

New environment surface:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PUBLIC_ORIGIN` | — (required) | `https://chat.philippeho.dev`; Better Auth `baseURL`, origin check, trusted origin |
| `SESSION_SECRET` | — (required, ≥32) | Better Auth secret and guest-cookie/IP HMAC key |
| `OWNER_USERNAME` | `phil` | First-boot seed only |
| `OWNER_EMAIL` | — (required first boot) | First-boot seed only |
| `OWNER_PASSWORD` | — (required first boot, ≥12) | First-boot seed only |
| `PHILCHAT_DB_PATH` | `/data/philchat.sqlite` | SQLite location |
| `GUEST_MESSAGE_LIMIT` | `5` | Messages per guest before sign-up is required |
| `GUEST_DAILY_MESSAGE_LIMIT` | `50` | Global guest messages per UTC day |
| `GUEST_MODEL_ALLOWLIST` | *(empty = all)* | Comma-separated model ids guests may use |
| `DEFAULT_MONTHLY_TOKEN_BUDGET` | `500000` | Per-approved-user monthly cap |
| `GLOBAL_DAILY_TOKEN_LIMIT` | `2000000` | Fleet-wide ceiling across all users and guests |

Removed at cutover: `ADMIN_PASSWORD`, `ADMIN_USERNAME`, `EXTRA_USERS`, `APP_BASE_PATH`,
`VITE_BASE_PATH`.

**Acceptance:** a pending user's sign-in returns 403 `ACCOUNT_PENDING` and sets no cookie;
an approved user's cookie is named `__Host-philchat_session` with `HttpOnly`,
`SameSite=Strict`, `Secure`, `Path=/`; a sign-up body carrying `"role":"owner"` creates a
`member`; booting without `SESSION_SECRET` exits non-zero with a clear message.

---

## Phase 3 — Guest trial

### `server/src/guests.js` (new)

A guest is identified by a signed `philchat_guest` cookie holding a random id, **issued
lazily on the first chat request** rather than to every visitor — today's
`saveUninitialized: true` hands a cookie to anyone who loads the page, which is both a
privacy wart and useless for the limit it is meant to enforce.

The cookie is `HttpOnly`, `SameSite=Strict`, `Secure` in production, and signed with
`SESSION_SECRET` so a guest cannot mint themselves a fresh id without clearing it. Strict
withholds it on a cross-site top-level navigation, but that request only returns
`index.html`; the SPA's own chat request afterwards is same-site and does carry it.

Counting takes `max(messages for this guest_id, sum of messages for this ip_hash)`, where
`ip_hash = HMAC-SHA256(ip, SESSION_SECRET)` — **no raw IP is ever stored**. `req.ip` is
already correct: `app.set("trust proxy", 1)` is set and Traefik is the only hop.

Both `guest_usage.messages_used` and `daily_budget.guest_messages` increment at the same
pre-flight point, in one transaction, before the upstream stream is opened — so a guest
message is spent whether or not the model answers. Tokens are recorded separately, after
the stream, per Phase 4.

This is not unbeatable — a VPN or a fresh mobile IP defeats it. It is not meant to be. It
raises the cost of casual farming, and `GUEST_DAILY_MESSAGE_LIMIT` in `daily_budget` is
the actual spend backstop, now surviving restarts instead of resetting on every deploy.

`GUEST_MODEL_ALLOWLIST`, when non-empty, restricts anonymous visitors to the listed model
ids, so a guest cannot point a public showcase at the most expensive model available. A
guest requesting a model outside it is refused with SSE `details: { modelNotAllowed: true }`
before any upstream call, and the frontend filters the picker to the allowlist so the
refusal is a backstop rather than the normal path.

**Acceptance:** a guest gets exactly `GUEST_MESSAGE_LIMIT` messages; clearing cookies does
not reset the count from the same IP; the counts survive a container restart; the global
daily cap refuses further guest traffic with a distinguishable error.

---

## Phase 4 — Token budgets

### `server/src/budget.js` (new)

Both providers already normalize usage into
`{ promptTokenCount, candidatesTokenCount, totalTokenCount }` — Google natively via
`usageMetadata`, NVIDIA through `normalizeNvidiaUsage` in `server/src/nvidia.js`. No
provider work is needed.

**Before opening the upstream stream:**

- signed-in, non-owner: `SUM(total_tokens)` from `usage_events` for that `user_id` with
  `created_at` in the current UTC calendar month, compared against
  `user.monthlyTokenBudget ?? DEFAULT_MONTHLY_TOKEN_BUDGET`
- always: `daily_budget.tokens` for today against `GLOBAL_DAILY_TOKEN_LIMIT`
- the owner is exempt from the per-user cap but is still counted toward both the event log
  and the global ceiling

**After the stream, in the existing `finally` block:** insert one `usage_events` row from
`finalUsage` and increment `daily_budget.tokens` in the same transaction. Aborted streams
record whatever usage arrived; a stream that reported none records nothing.

> **Known and accepted:** usage only arrives at the end of a stream, so enforcement is
> check-before / record-after. A user's final message can overshoot their cap by one
> response. Pre-flight estimation is deliberately not attempted — it would be wrong in
> both directions and the overshoot is bounded by one message.

Refusals are surfaced through the existing SSE `error` event with
`details: { budgetExhausted: true, scope: 'user' | 'global' }` so the UI can tell "you are
out" from "the site is out" without parsing prose.

**Acceptance:** a user at their cap is refused before any upstream call is made; usage
recorded on 31 Aug does not count against September's budget; a raised budget takes effect
on the next message with no restart.

---

## Phase 5 — Routes

`server/src/index.js` changes:

1. **Mount Better Auth before the body parser.**
   `app.all("/api/auth/*splat", toNodeHandler(auth))` must come **before**
   `express.json()`. This is Better Auth's documented Express gotcha; getting it wrong
   breaks sign-in in a way that looks like a credential problem. (Express 5 splat syntax —
   this repo already uses `/{*splat}`.)
2. **Delete** the `express-session` middleware, `POST /api/login` and `POST /api/logout`.
   Better Auth owns all three.
3. **Origin check**, before the session is resolved so a cross-origin caller does not even
   cost a session lookup: any unsafe method (not GET/HEAD/OPTIONS) on `/api/` whose
   `Origin` header is not `PUBLIC_ORIGIN` gets 403 `ORIGIN_REJECTED`.
4. **Default-deny middleware** with an explicit allowlist — adding a route must never
   silently open it:

   | Public | Reason |
   | --- | --- |
   | `GET|POST /api/auth/*` | Sign-in and sign-up must be reachable; polices itself |
   | `GET /api/bootstrap` | Provider availability for the landing state |
   | `GET /api/models` | Guests need a model picker |
   | `GET /api/me` | Reports guest allowance to anonymous callers |
   | `POST /api/chat/stream` | The guest trial itself; limited in Phase 3 |

   Everything else under `/api/` requires a session.
5. **`GET /api/usage` becomes owner-only.** It currently returns Google Cloud project
   quota, limits and headroom to anyone who asks.
6. **`GET /api/me`** is rewritten: for a session it returns user, role, month-to-date
   tokens, effective budget, and — for the owner — the pending-account count for a badge.
   For an anonymous caller it returns guest messages used and remaining.
7. **New owner-only admin routes**, ported from cloudsong's `admin.js`:
   - `GET /api/admin/users?status=pending|all` — explicit column list, never `SELECT *`,
     so a column added later must be opted into deliberately
   - `POST /api/admin/users/:id/approve`
   - `POST /api/admin/users/:id/reject` — **also deletes that user's rows from `session`.**
     Revocation is the whole point of server-side sessions: a rejected user's live session
     dies now rather than lasting until its token happens to expire
   - `PATCH /api/admin/users/:id/budget` — sets or clears `monthlyTokenBudget`
   - The owner row cannot be rejected or have its role changed (409), so the owner cannot
     lock themselves out of their own admin panel

**Acceptance:** every non-allowlisted `/api/` route returns 401 without a session; a
`member` session gets 403 on every `/api/admin/*` route; rejecting a signed-in user ends
their session on their next request.

---

## Phase 6 — Frontend

`webui` already has Tailwind 3 and React 19. Add `better-auth`'s `createAuthClient`
(`better-auth/react`) rather than hand-rolling fetches against the auth endpoints.

- `LoginModal.jsx` becomes `AuthModal.jsx`: sign-in and sign-up tabs, with explicit states
  for **pending approval** ("your account is waiting to be approved"), **guest limit
  reached**, and **budget exhausted** (distinguishing per-user from site-wide). The current
  copy "Sign in for unlimited access" becomes false under budgets and must change.
- Header: guest messages remaining when anonymous, month-to-date tokens against budget when
  signed in.
- `AdminPanel.jsx`, owner-only: pending accounts with approve/reject, per-user
  month-to-date tokens, and an inline budget override.
- `webui/src/lib/api.js`: drop `login`/`logout` in favour of the auth client; add the admin
  calls. `paths.js` simplifies once the base path is gone (Phase 0).

**Acceptance:** a guest sees their remaining count decrement and is prompted at zero; a
pending user sees the pending message rather than a generic failure; the admin panel is
absent, not merely hidden, for a member.

---

## Testing

The existing `node --test` suite (`server/test/config.test.js`, `nvidia.test.js`,
`providers.test.js`) must stay green; the deploy workflow runs `npm test` and `npm run
lint` before it will deploy anything. New tests, against `:memory:` databases:

- `database.test.js` — migrations apply once, are idempotent on a second boot, and a
  failing migration rolls back without recording its version
- `auth.test.js` — the approval gate refuses a pending user and issues no cookie; an
  approved user receives one; `role` supplied in a sign-up body is ignored
- `guests.test.js` — counting takes the max of cookie and IP hash; the global daily cap
  refuses beyond its limit; no raw IP is written to the database
- `budget.test.js` — month-boundary arithmetic, per-user cap, owner exemption, global
  ceiling, and that a refused request makes no upstream call

## Deployment

`.github/workflows/deploy.yml` continues to rsync to `/home/phil/projects/philchat/`, copy
into `/opt/philchat`, `docker build` and `docker compose up -d` on every push to `main`.
Two changes cannot be made by the workflow and must be done on the server, once, **before
the first deploy that contains Phase 1**:

1. Add the `/home/phil/app-data/philchat:/data` volume to
   `/opt/philchat/docker-compose.yml`.
2. Rewrite `/opt/philchat/.env`: delete `ADMIN_PASSWORD`, `ADMIN_USERNAME`, `EXTRA_USERS`,
   `APP_BASE_PATH`; add `PUBLIC_ORIGIN`, `SESSION_SECRET` (64 hex from
   `openssl rand -hex 32`), `OWNER_USERNAME`, `OWNER_EMAIL`, `OWNER_PASSWORD` (20+ random
   characters), and the budget variables.

Deleting `ADMIN_PASSWORD` is what closes the audit's "confirmed live 4-digit password"
finding — the code path that read it is gone, so the value cannot come back by being reset
to something short later.

Note that the Dockerfile only re-runs `npm install` when `server/package.json` changes;
adding `better-auth` and removing `bcryptjs`/`express-session` is such a change, so the
install layer rebuilds correctly on that deploy.

## Out of scope

- **MFA.** Better Auth supports it as configuration; the audit's own position is that
  deferring it is defensible for a personal tool. Revisit if this stops being one.
- **Cloudflare Access.** Access and public sign-up are opposing models; philchat is
  deliberately choosing public sign-up.
- **Chat history persistence.** Conversations stay client-side. The database exists for
  identity and metering only. Adding history is its own spec.
- **Password reset by email.** No SMTP dependency is being introduced. Recovery is a
  deliberate script run against the SQLite file over SSH, as with cloudsong.
- The other three 4-digit passwords in the fleet, and the rest of the audit's backlog.

## Risks

| Risk | Mitigation |
| --- | --- |
| Hand-written Better Auth DDL drifts from what 1.7 expects | Copy cloudsong's DDL verbatim, `issuer` column included; sign-up is covered by a test |
| `node:sqlite` on Node 24 in an alpine image | Already in production on cloudsong; no native build to fail |
| Guest cookie + IP is defeatable | Accepted; the global daily cap is the real spend limit |
| A user's last message overshoots their budget | Accepted and documented; bounded by one response |
| Losing the SQLite file loses all accounts | It lives on a host bind mount outside the image; nightly backup is a follow-up, not part of this work |
