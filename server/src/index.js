import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import cookieParser from "cookie-parser";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { registerAdminRoutes } from "./admin.js";
import { buildAuth } from "./auth.js";
import {
  AppError,
  buildBootstrapPayload,
  loadAuthConfig,
  loadRuntimeConfig,
} from "./config.js";
import { openDatabase } from "./database.js";
import { ensureOwner } from "./owner.js";
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WEBUI_DIST_PATH = path.resolve(__dirname, "../../webui/dist");

/**
 * Routes any visitor may call. Everything else under /api/ requires a session - the
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

function beginSseResponse(response) {
  response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders?.();
}

export function createApp({ database, auth, config }) {
  const app = express();
  const router = express.Router();

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

    // Checked before the session is resolved, so a cross-origin caller gets nothing -
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

    // Being signed in is what opens the default-deny gate; being the owner is a separate,
    // narrower fact used only for privileged routes and views.
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

  router.get("/api/me", (request, response) => {
    if (request.authUser) {
      const pendingUserCount = request.isOwner
        ? database.connection
            .prepare(
              `SELECT COUNT(*) AS count FROM "user" WHERE "approvalStatus" = 'pending'`
            )
            .get().count
        : undefined;

      response.json({
        authenticated: true,
        user: {
          id: request.authUser.id,
          username: request.authUser.username,
          role: request.authUser.role,
        },
        ...(pendingUserCount === undefined ? {} : { pendingUserCount }),
      });
      return;
    }

    response.json({
      authenticated: false,
      guest: {
        messagesUsed: 0,
        messagesLimit: config.guestMessageLimit,
        messagesRemaining: config.guestMessageLimit,
      },
    });
  });

  router.get("/api/bootstrap", async (_request, response) => {
    try {
      const runtimeConfig = await loadRuntimeConfig();
      const providerStatus = await verifyProviderConnections(runtimeConfig);
      response.json(buildBootstrapPayload(runtimeConfig, providerStatus));
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
      const runtimeConfig = await loadRuntimeConfig();
      const payload = await fetchProviderModels(runtimeConfig);
      response.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/usage", async (request, response) => {
    // The default-deny middleware already turned anonymous callers away; this separates
    // a member from the owner. It returns project-level Google Cloud quota, which has no
    // business reaching anyone else.
    if (!request.isOwner) {
      response.status(403).json(errorPayload("FORBIDDEN", "Owner access required."));
      return;
    }

    const runtimeConfig = await loadRuntimeConfig().catch((error) => {
      const normalizedError = toClientError(error);
      return {
        googleCloudProjectId: "",
        googleCloudQuotaService: "generativelanguage.googleapis.com",
        googleCloudQuotaLookbackHours: 24,
        configError: normalizedError,
      };
    });

    if (runtimeConfig.configError) {
      response.json({
        status: "setup_required",
        projectId: null,
        service: runtimeConfig.googleCloudQuotaService,
        checkedAt: new Date().toISOString(),
        lookbackHours: runtimeConfig.googleCloudQuotaLookbackHours,
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
          service: runtimeConfig.googleCloudQuotaService,
          authMethod: "application_default_credentials",
          env: ["GOOGLE_CLOUD_PROJECT_ID", "GOOGLE_APPLICATION_CREDENTIALS"],
          instructions: [
            "Fix the runtime config read error first so the server can finish bootstrapping normally.",
          ],
        },
        error: runtimeConfig.configError,
        notes: ["Quota lookup is optional and does not affect the existing chat proxy."],
        assumptions: [],
      });
      return;
    }

    const payload = await fetchQuotaDashboard({
      projectId: runtimeConfig.googleCloudProjectId,
      serviceName: runtimeConfig.googleCloudQuotaService,
      lookbackHours: runtimeConfig.googleCloudQuotaLookbackHours,
    });
    response.json(payload);
  });

  router.post("/api/chat/stream", async (request, response) => {
    const upstreamAbortController = new AbortController();
    request.on("aborted", () => {
      upstreamAbortController.abort();
    });

    beginSseResponse(response);

    let finalUsage = null;
    let aggregatedParts = [];

    try {
      const runtimeConfig = await loadRuntimeConfig();
      const { provider, response: streamResponse } = await openProviderChatStream({
        config: runtimeConfig,
        provider: request.body?.provider,
        modelId: request.body?.modelId,
        systemPrompt: request.body?.systemPrompt ?? runtimeConfig.defaultSystemPrompt,
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

  registerAdminRoutes(router, { database, config });

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
          "The web UI build was not found. Run `npm install && npm run build` inside the webui directory first."
        );
    });
  });

  app.use(router);

  app.use((error, _request, response, _next) => {
    const normalizedError = toClientError(error);
    response.status(normalizedError.httpCode || 500).json(normalizedError);
  });

  return app;
}

export function mergeParts(existingParts, incomingParts) {
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

export function toClientError(error, fallbackModelId = null) {
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

// Only start a server when run directly. Tests import createApp and listen on an
// ephemeral port of their own.
const isEntrypoint =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === __filename;

if (isEntrypoint) {
  const config = loadAuthConfig();
  const database = openDatabase(config.databasePath);
  const auth = buildAuth({ connection: database.connection, config });

  await ensureOwner({
    auth,
    connection: database.connection,
    config,
    log: (message) => console.log(message),
  });

  const app = createApp({ database, auth, config });
  const HOST = process.env.HOST || "127.0.0.1";
  const PORT = Number(process.env.PORT || 8787);

  app.listen(PORT, HOST, () => {
    console.log(`philchat server listening on http://${HOST}:${PORT}`);
  });
}
