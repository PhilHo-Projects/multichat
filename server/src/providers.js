import { AppError } from "./config.js";
import {
  fetchModels as fetchGoogleModels,
  openChatStream as openGoogleChatStream,
  verifyGoogleConnection,
} from "./google.js";
import {
  NVIDIA_DEEPSEEK_V4_PRO_MODEL,
  fetchNvidiaModels,
  normalizeNvidiaStreamChunk,
  openNvidiaChatStream,
} from "./nvidia.js";
import { normalizeResponseParts } from "./sse.js";

export const PROVIDER_GOOGLE = "google";
export const PROVIDER_NVIDIA = "nvidia";

const PROVIDER_LABELS = {
  [PROVIDER_GOOGLE]: "Google",
  [PROVIDER_NVIDIA]: "NVIDIA",
};

export function decorateGoogleModel(model) {
  return {
    ...model,
    provider: PROVIDER_GOOGLE,
    providerLabel: PROVIDER_LABELS[PROVIDER_GOOGLE],
    apiModelId: model.apiModelId ?? model.id,
  };
}

export function resolveProviderForModel({ provider, modelId }) {
  const normalizedProvider = normalizeProvider(provider);
  if (normalizedProvider) {
    return normalizedProvider;
  }

  if (modelId === NVIDIA_DEEPSEEK_V4_PRO_MODEL.id) {
    return PROVIDER_NVIDIA;
  }

  return PROVIDER_GOOGLE;
}

export async function verifyProviderConnections(config) {
  const googleStatus = config.googleApiKey
    ? await verifyGoogleConnection(config.googleApiKey)
    : buildMissingKeyStatus("Google");

  return {
    google: googleStatus,
    nvidia: verifyNvidiaConnection(config.nvidiaApiKey),
  };
}

export function verifyNvidiaConnection(apiKey) {
  if (!apiKey) {
    return buildMissingKeyStatus("NVIDIA");
  }

  return {
    canConnect: true,
    error: null,
  };
}

export async function fetchProviderModels(config) {
  const models = [];
  const providerErrors = [];

  if (config.googleApiKey) {
    try {
      const googleModels = await fetchGoogleModels(config.googleApiKey);
      models.push(...googleModels.map(decorateGoogleModel));
    } catch (error) {
      providerErrors.push(toProviderError(error, PROVIDER_GOOGLE));
    }
  }

  if (config.nvidiaApiKey) {
    try {
      const nvidiaModels = await fetchNvidiaModels(config.nvidiaApiKey);
      models.push(...nvidiaModels);
    } catch (error) {
      providerErrors.push(toProviderError(error, PROVIDER_NVIDIA));
    }
  }

  models.sort(compareModels);

  return {
    models,
    providerErrors,
  };
}

export async function openProviderChatStream({
  config,
  provider,
  modelId,
  systemPrompt,
  messages,
  signal,
}) {
  const resolvedProvider = resolveProviderForModel({ provider, modelId });

  if (resolvedProvider === PROVIDER_NVIDIA) {
    return {
      provider: resolvedProvider,
      response: await openNvidiaChatStream({
        apiKey: config.nvidiaApiKey,
        modelId,
        systemPrompt,
        messages,
        signal,
      }),
    };
  }

  return {
    provider: resolvedProvider,
    response: await openGoogleChatStream({
      apiKey: config.googleApiKey,
      modelId,
      systemPrompt,
      messages,
      signal,
    }),
  };
}

export function normalizeProviderStreamChunk(provider, payload) {
  if (provider === PROVIDER_NVIDIA) {
    return normalizeNvidiaStreamChunk(payload);
  }

  const candidate = payload.candidates?.[0];
  const parts = normalizeResponseParts(candidate?.content?.parts ?? []);
  const text = parts
    .filter((part) => part.type === "text" && part.text.length > 0)
    .map((part) => part.text)
    .join("");

  return {
    parts,
    text,
    usage: payload.usageMetadata ?? null,
  };
}

function buildMissingKeyStatus(label) {
  return {
    canConnect: false,
    error: {
      httpCode: 503,
      googleStatus: null,
      message: `No ${label} API key was found in the runtime config.`,
      modelId: null,
      details: null,
    },
  };
}

function normalizeProvider(provider) {
  const normalizedProvider = String(provider ?? "").trim().toLowerCase();
  if ([PROVIDER_GOOGLE, PROVIDER_NVIDIA].includes(normalizedProvider)) {
    return normalizedProvider;
  }

  return "";
}

function compareModels(left, right) {
  const leftProviderScore = left.provider === PROVIDER_NVIDIA ? 1 : 0;
  const rightProviderScore = right.provider === PROVIDER_NVIDIA ? 1 : 0;

  if (leftProviderScore !== rightProviderScore) {
    return leftProviderScore - rightProviderScore;
  }

  return left.displayName.localeCompare(right.displayName);
}

function toProviderError(error, provider) {
  if (error instanceof AppError) {
    return {
      provider,
      httpCode: error.httpCode,
      googleStatus: error.googleStatus,
      message: error.message,
      modelId: error.modelId,
      details: error.details,
    };
  }

  return {
    provider,
    httpCode: 500,
    googleStatus: null,
    message: error?.message ?? "Unexpected provider error.",
    modelId: null,
    details: null,
  };
}
