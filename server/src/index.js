import express from "express";
import session from "express-session";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AppError,
  buildBootstrapPayload,
  loadRuntimeConfig,
  normalizeAppBasePath,
} from "./config.js";
import {
  fetchProviderModels,
  normalizeProviderStreamChunk,
  openProviderChatStream,
  PROVIDER_NVIDIA,
  verifyProviderConnections,
} from "./providers.js";
import { sendSseEvent, streamGoogleSse } from "./sse.js";
import { streamNvidiaSse } from "./nvidia.js";
import { fetchQuotaDashboard } from "./usage.js";
import {
  verifyCredentials,
  isAuthEnabled,
  getPublicMessageLimit,
  getDailyLimitStatus,
  consumeDailyMessage,
} from "./auth.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WEBUI_DIST_PATH = path.resolve(__dirname, "../../webui/dist");
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 8787);
const APP_BASE_PATH = normalizeAppBasePath(process.env.APP_BASE_PATH);

const app = express();
const router = express.Router();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev-secret-change-in-production",
    resave: false,
    saveUninitialized: true,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 24 * 60 * 60 * 1000,
    },
  })
);

router.get("/api/me", (request, response) => {
  if (request.session.user) {
    response.json({ authenticated: true, username: request.session.user.username });
    return;
  }

  const sessionLimit = getPublicMessageLimit();
  const sessionUsed = request.session.messageCount || 0;
  const daily = getDailyLimitStatus();
  response.json({
    authenticated: false,
    messagesUsed: sessionUsed,
    messagesLimit: isAuthEnabled() ? sessionLimit : null,
    messagesRemaining: isAuthEnabled() ? Math.max(0, sessionLimit - sessionUsed) : null,
    dailyUsed: isAuthEnabled() ? daily.used : null,
    dailyLimit: isAuthEnabled() ? daily.limit : null,
    dailyRemaining: isAuthEnabled() ? Math.max(0, daily.limit - daily.used) : null,
  });
});

router.post("/api/login", async (request, response) => {
  const { username, password } = request.body || {};

  if (!username || !password) {
    response.status(400).json({ message: "Username and password required." });
    return;
  }

  if (!isAuthEnabled()) {
    response.status(503).json({ message: "Auth is not configured on this server." });
    return;
  }

  const valid = await verifyCredentials(username, password);
  if (!valid) {
    response.status(401).json({ message: "Invalid username or password." });
    return;
  }

  request.session.user = { username };
  request.session.messageCount = 0;
  response.json({ authenticated: true, username });
});

router.post("/api/logout", (request, response) => {
  request.session.destroy(() => {
    response.json({ success: true });
  });
});

router.get("/api/bootstrap", async (_request, response) => {
  try {
    const config = await loadRuntimeConfig();
    const providerStatus = await verifyProviderConnections(config);
    response.json(buildBootstrapPayload(config, providerStatus));
  } catch (error) {
    const normalizedError = toClientError(error);
    const providerError = {
      canConnect: false,
      checkedAt: new Date().toISOString(),
      error: normalizedError,
    };
    response.json({
      keySource: {
        path: normalizedError.details?.path ?? null,
        readable: false,
        present: false,
      },
      defaults: {
        provider: "google",
        model: "",
        systemPrompt: "",
      },
      google: providerError,
      nvidia: providerError,
      providers: {
        google: providerError,
        nvidia: providerError,
      },
    });
  }
});

router.get("/api/models", async (_request, response, next) => {
  try {
    const config = await loadRuntimeConfig();
    const payload = await fetchProviderModels(config);
    response.json(payload);
  } catch (error) {
    next(error);
  }
});

router.get("/api/usage", async (_request, response) => {
  const config = await loadRuntimeConfig().catch((error) => {
    const normalizedError = toClientError(error);
    return {
      googleCloudProjectId: "",
      googleCloudQuotaService: "generativelanguage.googleapis.com",
      googleCloudQuotaLookbackHours: 24,
      configError: normalizedError,
    };
  });

  if (config.configError) {
    response.json({
      status: "setup_required",
      projectId: null,
      service: config.googleCloudQuotaService,
      checkedAt: new Date().toISOString(),
      lookbackHours: config.googleCloudQuotaLookbackHours,
      auth: {
        method: "application_default_credentials",
        credentialType: null,
        principalEmail: null,
      },
      summary: {
        totalItems: 0,
        exhaustedCount: 0,
        nearLimitCount: 0,
        modelCount: 0,
        projectWideCount: 0,
      },
      items: [],
      modelSummaries: [],
      setup: {
        projectIdConfigured: false,
        projectId: null,
        service: config.googleCloudQuotaService,
        authMethod: "application_default_credentials",
        env: ["GOOGLE_CLOUD_PROJECT_ID", "GOOGLE_APPLICATION_CREDENTIALS"],
        instructions: [
          "Fix the runtime config read error first so the server can finish bootstrapping normally.",
        ],
      },
      error: config.configError,
      notes: [
        "Quota lookup is optional and does not affect the existing chat proxy.",
      ],
      assumptions: [],
    });
    return;
  }

  const payload = await fetchQuotaDashboard({
    projectId: config.googleCloudProjectId,
    serviceName: config.googleCloudQuotaService,
    lookbackHours: config.googleCloudQuotaLookbackHours,
  });
  response.json(payload);
});

router.post("/api/chat/stream", async (request, response) => {
  if (!request.session.user && isAuthEnabled()) {
    const sessionLimit = getPublicMessageLimit();
    const sessionUsed = request.session.messageCount || 0;

    if (sessionUsed >= sessionLimit) {
      response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      response.setHeader("Cache-Control", "no-cache, no-transform");
      response.setHeader("Connection", "keep-alive");
      response.flushHeaders?.();
      sendSseEvent(response, "error", {
        httpCode: 429,
        googleStatus: null,
        message: `You've used all ${sessionLimit} guest messages. Sign in for unlimited access.`,
        modelId: null,
        provider: null,
        details: { limitReached: true, limit: sessionLimit },
      });
      response.end();
      return;
    }

    const dailyOk = consumeDailyMessage();
    if (!dailyOk) {
      const daily = getDailyLimitStatus();
      response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      response.setHeader("Cache-Control", "no-cache, no-transform");
      response.setHeader("Connection", "keep-alive");
      response.flushHeaders?.();
      sendSseEvent(response, "error", {
        httpCode: 429,
        googleStatus: null,
        message: `Today's public message budget (${daily.limit}) is used up. Come back tomorrow!`,
        modelId: null,
        provider: null,
        details: { dailyLimitReached: true, limit: daily.limit },
      });
      response.end();
      return;
    }

    request.session.messageCount = sessionUsed + 1;
  }

  const upstreamAbortController = new AbortController();
  request.on("aborted", () => {
    upstreamAbortController.abort();
  });

  response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders?.();

  let finalUsage = null;
  let aggregatedParts = [];

  try {
    const config = await loadRuntimeConfig();
    const { provider, response: streamResponse } = await openProviderChatStream({
      config,
      provider: request.body?.provider,
      modelId: request.body?.modelId,
      systemPrompt: request.body?.systemPrompt ?? config.defaultSystemPrompt,
      messages: request.body?.messages,
      signal: upstreamAbortController.signal,
    });

    sendSseEvent(response, "start", {
      modelId: request.body.modelId,
      provider,
      startedAt: new Date().toISOString(),
    });

    const streamProviderSse =
      provider === PROVIDER_NVIDIA ? streamNvidiaSse : streamGoogleSse;

    await streamProviderSse(streamResponse.body, {
      onChunk: async (payload) => {
        const {
          parts: responseParts,
          text: textDelta,
          usage,
        } = normalizeProviderStreamChunk(provider, payload);

        if (responseParts.length > 0) {
          aggregatedParts = mergeParts(aggregatedParts, responseParts);
        }

        if (textDelta || responseParts.some((part) => part.type !== "text")) {
          sendSseEvent(response, "delta", {
            text: textDelta,
            parts: responseParts,
          });
        }

        if (usage) {
          finalUsage = usage;
          sendSseEvent(response, "usage", finalUsage);
        }
      },
    });

    sendSseEvent(response, "complete", {
      message: {
        role: "assistant",
        parts: aggregatedParts,
      },
      usage: finalUsage,
      completedAt: new Date().toISOString(),
    });
  } catch (error) {
    const normalizedError =
      error.name === "AbortError"
        ? {
            httpCode: 499,
            googleStatus: null,
            message: "Request cancelled.",
            modelId: request.body?.modelId ?? null,
            details: null,
          }
        : toClientError(error, request.body?.modelId ?? null);

    sendSseEvent(response, "error", normalizedError);
  } finally {
    response.end();
  }
});

router.use("/assets", express.static(path.join(WEBUI_DIST_PATH, "assets")));
router.use(express.static(WEBUI_DIST_PATH));

router.get("/{*splat}", (_request, response) => {
  response.sendFile(path.join(WEBUI_DIST_PATH, "index.html"), (error) => {
    if (!error) {
      return;
    }

    response
      .status(503)
      .type("text/plain")
      .send(
        "The web UI build was not found. Run `npm install && npm run build` inside D:\\GoogleModels\\webui first."
      );
  });
});

if (APP_BASE_PATH) {
  app.use((request, response, next) => {
    if (request.path === APP_BASE_PATH) {
      response.redirect(301, `${APP_BASE_PATH}/`);
      return;
    }

    next();
  });
  app.use(APP_BASE_PATH, router);
} else {
  app.use(router);
}

app.use((error, _request, response, _next) => {
  const normalizedError = toClientError(error);
  response.status(normalizedError.httpCode || 500).json(normalizedError);
});

app.listen(PORT, HOST, () => {
  console.log(
    `Multichat server listening on http://${HOST}:${PORT}${APP_BASE_PATH || ""}`
  );
});

function mergeParts(existingParts, incomingParts) {
  const merged = [...existingParts];

  for (const part of incomingParts) {
    if (part.type === "text") {
      const lastPart = merged.at(-1);
      if (lastPart?.type === "text") {
        lastPart.text += part.text;
      } else {
        merged.push({ ...part });
      }
      continue;
    }

    merged.push(part);
  }

  return merged;
}

function toClientError(error, fallbackModelId = null) {
  if (error instanceof AppError) {
    return {
      httpCode: error.httpCode,
      googleStatus: error.googleStatus,
      message: error.message,
      modelId: error.modelId ?? fallbackModelId,
      provider: error.provider ?? null,
      details: error.details,
    };
  }

  return {
    httpCode: 500,
    googleStatus: null,
    message: error?.message ?? "Unexpected server error.",
    modelId: fallbackModelId,
    provider: null,
    details: null,
  };
}
