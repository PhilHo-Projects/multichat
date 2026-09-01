# Multichat (philchat)

Multi-model chat client for Google Gemini/Gemma and NVIDIA-hosted models in one UI,
deployed at [chat.philippeho.dev](https://chat.philippeho.dev).

Anyone may try it for a few messages without an account. Beyond that it needs one, and
new accounts are approved by hand before they can sign in. Approved accounts are metered
against a monthly token budget.

## Layout

- `server/` - Node proxy that serves the built UI, lists models, streams chat responses,
  and owns auth, the guest trial and token metering
  - `auth.js` / `owner.js` - Better Auth configuration, the approval gate, first-boot owner seed
  - `database.js` - `node:sqlite` connection and every migration
  - `guests.js` - guest identity and the anonymous trial allowance
  - `budget.js` - token accounting and budget enforcement
  - `admin.js` - owner-only account administration
- `webui/` - React + Vite frontend adapted from Google's `Gemma3-on-Web` demo

## Run

### 1. Start the server

```powershell
Set-Location D:\GoogleModels\server
npm install
npm start
```

The app listens on `http://127.0.0.1:8787`. It will refuse to start until the required
auth variables from `.env.example` are set.

### 2. Frontend dev mode

```powershell
Set-Location D:\GoogleModels\webui
npm install
npm run dev
```

Vite runs on `http://127.0.0.1:5173` and proxies `/api` to the local server.

### 3. Production build

```powershell
Set-Location D:\GoogleModels
npm run build
```

The Node server serves `webui/dist` automatically.

## Auth

Better Auth owns identity; there is no second auth path. The details that matter:

- **Sign-up is public, sign-in is not.** A new account is created `pending` and cannot hold
  a session until the owner approves it. The gate sits at session creation, so the
  existence of a session proves approval and no downstream route re-checks.
- **`role` and `approvalStatus` are server-owned** (`input: false`), so a sign-up body
  carrying `"role":"owner"` cannot escalate.
- **Guests** get `GUEST_MESSAGE_LIMIT` messages, counted by signed cookie *and* hashed IP,
  under a global daily ceiling. Only an HMAC of the IP is stored, never the address.
- **Budgets** are checked before a stream opens and recorded after it closes, so a user's
  last message can overshoot their cap by one response. That is accepted; estimating
  tokens up front would be wrong in both directions.
- **No password reset flow.** Recovery is a deliberate script run against the SQLite file
  over SSH. `OWNER_PASSWORD` seeds the owner on first boot only and is ignored afterwards.

## Deployment

Coolify pulls this repo and builds the `Dockerfile`, which builds the web UI itself.
Nothing pushes to the server, so no CI credential has access to it.

- App: `philchat` in Coolify, public repo, `main`, Dockerfile build pack, port 8791
- Data: `/home/phil/app-data/philchat` bind-mounted to `/data`; the SQLite file holding
  every account lives there, outside the image
- Releases are manual - a push to `main` runs CI but does not deploy
- `.github/workflows/ci.yml` runs tests, lint and a production image build

## Notes

- The browser never receives the raw Google or NVIDIA API key.
- The server reloads the preferred runtime config on bootstrap, model listing, and every chat request.
- Required environment variables have no fallbacks: the server refuses to boot without
  `PUBLIC_ORIGIN`, `SESSION_SECRET`, `OWNER_EMAIL` and `OWNER_PASSWORD`. An app that will
  not boot is a loud failure; one running on a known default is a silent one. See
  `.env.example` for the full surface.
- Some Gemma models reject Google's `systemInstruction` field. The server automatically falls back by inlining the system prompt into the first user turn when Google returns that specific compatibility error.
- Rate-limit and quota failures are surfaced to the UI with the model id and Google error details.

## Google quota dashboard

The app now includes a project-level quota/usage dashboard backed by Google Cloud Monitoring for `generativelanguage.googleapis.com`.

### Endpoints

- `GET /api/usage` - returns normalized project/model quota usage when Cloud Monitoring auth is configured

### Recommended auth

Use Google Application Default Credentials on the server. For this local app, the simplest practical setup is:

1. Create or choose a Google Cloud service account.
2. Grant it `roles/monitoring.viewer` on the target project.
3. Download the JSON key to a local path that stays server-side.
4. Point the server at that key with `GOOGLE_APPLICATION_CREDENTIALS`.

The browser never receives the service account key or any OAuth token.

### Required server-side config

In PowerShell before starting the server:

```powershell
$env:GOOGLE_CLOUD_PROJECT_ID = "gen-lang-client-0092019317"
$env:GOOGLE_APPLICATION_CREDENTIALS = "C:\path\to\google-monitoring-reader.json"
Set-Location D:\GoogleModels\server
npm start
```

Optional:

```powershell
$env:GOOGLE_CLOUD_QUOTA_LOOKBACK_HOURS = "24"
```

### What the dashboard shows

- current usage
- current limit
- remaining headroom
- whether a limit looks exhausted or near limit
- model-specific quota rows when Google emits a `model` label
- project-wide rows when the metric has no model label
- when the usage snapshot was checked

### Current limitations

- The quota endpoint depends on Cloud Monitoring auth, not the Gemini API key alone.
- Google exposes some quota families per model and others only project-wide.
- Usage is derived from the newest Cloud Monitoring time series points for each quota family, so it can lag real-time by a few minutes.
