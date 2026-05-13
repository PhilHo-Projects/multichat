# Multichat

Private multi-model chat client for trying live Google Gemini/Gemma and NVIDIA-hosted models from one UI.

## Layout

- `server/` - local Node proxy that prefers environment variables or `C:\Users\phili\AppData\Roaming\GoogleModels\config.json`, falls back to `C:\Users\phili\AppData\Roaming\com.prevonco.dev\config.json`, serves the built UI, lists models, and streams chat responses
- `webui/` - React + Vite frontend adapted from Google's `Gemma3-on-Web` demo

## Run

### 1. Start the server

```powershell
Set-Location D:\GoogleModels\server
npm install
npm start
```

The app listens on `http://127.0.0.1:8787`.

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

For the AWS path deploy:

```powershell
$env:VITE_BASE_PATH = "/philchat/"
npm run build
Remove-Item Env:VITE_BASE_PATH
```

## Notes

- The browser never receives the raw Google API key.
- The server reloads the preferred runtime config on bootstrap, model listing, and every chat request.
- For deployment, the server can use environment variables instead of the local Windows config file. Set `GOOGLE_API_KEY`, `NVIDIA_API_KEY`, `DEFAULT_PROVIDER`, `DEFAULT_MODEL`, and `DEFAULT_SYSTEM_PROMPT` in PM2/AWS. Real `.env` files are git-ignored; use `.env.example` only as a placeholder template.
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
