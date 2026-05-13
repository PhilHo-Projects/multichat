import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const GOOGLE_MODELS_CONFIG_PATH =
  "C:\\Users\\phili\\AppData\\Roaming\\GoogleModels\\config.json";
export const PREVONCO_CONFIG_PATH =
  "C:\\Users\\phili\\AppData\\Roaming\\com.prevonco.dev\\config.json";
export const RUNTIME_CONFIG_PATHS = [
  GOOGLE_MODELS_CONFIG_PATH,
  PREVONCO_CONFIG_PATH,
];
export const DEFAULT_GOOGLE_CLOUD_QUOTA_SERVICE =
  "generativelanguage.googleapis.com";
export const DEFAULT_GOOGLE_CLOUD_QUOTA_LOOKBACK_HOURS = 24;
export const DEFAULT_PROVIDER = "google";
export const SUPPORTED_PROVIDERS = ["google", "nvidia"];
export const DOTENV_PATHS = [
  path.resolve(__dirname, "../../.env"),
  path.resolve(__dirname, "../../.env.local"),
  path.resolve(__dirname, "../.env"),
  path.resolve(__dirname, "../.env.local"),
];

export class AppError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "AppError";
    this.httpCode = options.httpCode ?? 500;
    this.googleStatus = options.googleStatus ?? null;
    this.details = options.details ?? null;
    this.modelId = options.modelId ?? null;
    this.provider = options.provider ?? null;
  }
}

export async function loadRuntimeConfig() {
  const env = {
    ...(await loadDotEnvConfig()),
    ...process.env,
  };
  let loadedConfig;

  try {
    loadedConfig = await loadPreferredRuntimeConfig();
  } catch (error) {
    if (!hasEnvRuntimeConfig(env)) {
      throw error;
    }

    loadedConfig = {
      parsedConfig: {},
      configPath: "environment variables",
    };
  }

  return parseRuntimeConfig(
    loadedConfig.parsedConfig,
    loadedConfig.configPath,
    env
  );
}

export function parseRuntimeConfig(parsedConfig, configPath, env = {}) {
  const envConfig = buildEnvRuntimeConfig(env);
  const mergedConfig = {
    ...parsedConfig,
    ...compactConfig(envConfig),
  };
  const googleApiKey = readStringValue(mergedConfig.api_key);
  const nvidiaApiKey = readStringValue(mergedConfig.nvidia_api_key);
  const defaultProvider =
    normalizeProvider(readStringValue(mergedConfig.default_provider)) ||
    normalizeProvider(readStringValue(mergedConfig.provider)) ||
    DEFAULT_PROVIDER;

  return {
    apiKey: googleApiKey,
    googleApiKey,
    nvidiaApiKey,
    defaultProvider,
    defaultModel:
      typeof mergedConfig.model === "string" ? mergedConfig.model.trim() : "",
    defaultSystemPrompt:
      typeof mergedConfig.system_instruction === "string"
        ? mergedConfig.system_instruction
        : "",
    googleCloudProjectId: readFirstStringEnv([
      "GOOGLE_CLOUD_PROJECT_ID",
      "GOOGLE_CLOUD_PROJECT",
      "GCLOUD_PROJECT",
      "GOOGLE_PROJECT_ID",
    ], env),
    googleCloudQuotaService:
      readFirstStringEnv(["GOOGLE_CLOUD_QUOTA_SERVICE"], env) ||
      DEFAULT_GOOGLE_CLOUD_QUOTA_SERVICE,
    googleCloudQuotaLookbackHours: readNumberEnv(
      "GOOGLE_CLOUD_QUOTA_LOOKBACK_HOURS",
      DEFAULT_GOOGLE_CLOUD_QUOTA_LOOKBACK_HOURS,
      env
    ),
    configPath,
  };
}

export function buildEnvRuntimeConfig(env = process.env) {
  return {
    api_key: readFirstStringEnv(
      ["GOOGLE_API_KEY", "GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
      env
    ),
    nvidia_api_key: readFirstStringEnv(["NVIDIA_API_KEY"], env),
    default_provider: readFirstStringEnv(["DEFAULT_PROVIDER", "PROVIDER"], env),
    model: readFirstStringEnv(["DEFAULT_MODEL", "MODEL"], env),
    system_instruction: readFirstStringEnv(
      ["DEFAULT_SYSTEM_PROMPT", "SYSTEM_PROMPT"],
      env
    ),
  };
}

export function parseDotEnv(rawValue) {
  const parsedEnv = {};

  for (const rawLine of String(rawValue ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }

    parsedEnv[key] = stripEnvQuotes(line.slice(separatorIndex + 1).trim());
  }

  return parsedEnv;
}

export function normalizeAppBasePath(value) {
  const normalizedValue = String(value ?? "").trim();
  if (!normalizedValue || normalizedValue === "/") {
    return "";
  }

  return `/${normalizedValue.replace(/^\/+|\/+$/g, "")}`;
}

export function buildBootstrapPayload(config, status = {}) {
  const googleStatus = status.google ?? status ?? {};
  const nvidiaStatus = status.nvidia ?? {};
  const googleKeyPresent = Boolean(config.googleApiKey ?? config.apiKey);
  const nvidiaKeyPresent = Boolean(config.nvidiaApiKey);
  const google = buildProviderBootstrapStatus({
    provider: "google",
    keyPresent: googleKeyPresent,
    status: googleStatus,
  });
  const nvidia = buildProviderBootstrapStatus({
    provider: "nvidia",
    keyPresent: nvidiaKeyPresent,
    status: nvidiaStatus,
  });

  return {
    keySource: {
      path: config.configPath,
      readable: true,
      present: googleKeyPresent || nvidiaKeyPresent,
    },
    defaults: {
      provider: config.defaultProvider,
      model: config.defaultModel,
      systemPrompt: config.defaultSystemPrompt,
    },
    google,
    nvidia,
    providers: {
      google,
      nvidia,
    },
    usage: {
      projectId: config.googleCloudProjectId || null,
      service: config.googleCloudQuotaService,
      lookbackHours: config.googleCloudQuotaLookbackHours,
    },
  };
}

function buildProviderBootstrapStatus({ provider, keyPresent, status }) {
  return {
    provider,
    keyPresent,
    canConnect: Boolean(status.canConnect),
    checkedAt: new Date().toISOString(),
    error: status.error ?? null,
  };
}

async function loadPreferredRuntimeConfig() {
  for (const configPath of RUNTIME_CONFIG_PATHS) {
    let rawConfig;

    try {
      rawConfig = await readFile(configPath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        continue;
      }

      throw new AppError(
        `Could not read runtime config at ${configPath}: ${error.message}`,
        {
          httpCode: 503,
          details: {
            path: configPath,
          },
        }
      );
    }

    try {
      return {
        parsedConfig: JSON.parse(rawConfig),
        configPath,
      };
    } catch (error) {
      throw new AppError(
        `Runtime config at ${configPath} is not valid JSON: ${error.message}`,
        {
          httpCode: 503,
          details: {
            path: configPath,
          },
        }
      );
    }
  }

  throw new AppError(
    `Could not find a runtime config. Checked ${RUNTIME_CONFIG_PATHS.join(" and ")}.`,
    {
      httpCode: 503,
      details: {
        path: GOOGLE_MODELS_CONFIG_PATH,
        checkedPaths: RUNTIME_CONFIG_PATHS,
      },
    }
  );
}

async function loadDotEnvConfig(dotEnvPaths = DOTENV_PATHS) {
  const mergedEnv = {};

  for (const dotEnvPath of dotEnvPaths) {
    let rawEnv;

    try {
      rawEnv = await readFile(dotEnvPath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        continue;
      }

      throw new AppError(`Could not read dotenv file at ${dotEnvPath}: ${error.message}`, {
        httpCode: 503,
        details: {
          path: dotEnvPath,
        },
      });
    }

    Object.assign(mergedEnv, parseDotEnv(rawEnv));
  }

  return mergedEnv;
}

function hasEnvRuntimeConfig(env) {
  const envConfig = buildEnvRuntimeConfig(env);
  return Object.values(envConfig).some((value) => readStringValue(value));
}

function compactConfig(config) {
  return Object.fromEntries(
    Object.entries(config).filter(([_key, value]) => readStringValue(value))
  );
}

function readFirstStringEnv(names, env = process.env) {
  for (const name of names) {
    const value = env[name];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}

function readStringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function stripEnvQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function normalizeProvider(value) {
  const normalizedValue = value.trim().toLowerCase();
  return SUPPORTED_PROVIDERS.includes(normalizedValue) ? normalizedValue : "";
}

function readNumberEnv(name, fallbackValue, env = process.env) {
  const rawValue = env[name];
  if (typeof rawValue !== "string" || !rawValue.trim()) {
    return fallbackValue;
  }

  const parsedValue = Number(rawValue);
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return fallbackValue;
  }

  return parsedValue;
}
