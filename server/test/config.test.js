import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEnvRuntimeConfig,
  loadAuthConfig,
  parseDotEnv,
  parseRuntimeConfig,
} from "../src/config.js";

test("parseRuntimeConfig preserves legacy Google config and defaults to Google", () => {
  const config = parseRuntimeConfig(
    {
      api_key: " google-key ",
      model: " gemini-2.5-pro ",
      system_instruction: "Be useful.",
    },
    "C:\\config.json"
  );

  assert.equal(config.apiKey, "google-key");
  assert.equal(config.googleApiKey, "google-key");
  assert.equal(config.nvidiaApiKey, "");
  assert.equal(config.defaultProvider, "google");
  assert.equal(config.defaultModel, "gemini-2.5-pro");
  assert.equal(config.defaultSystemPrompt, "Be useful.");
  assert.equal(config.configPath, "C:\\config.json");
});

test("parseRuntimeConfig accepts NVIDIA key and default provider without exposing it to bootstrap", () => {
  const config = parseRuntimeConfig(
    {
      api_key: "google-key",
      nvidia_api_key: " nvidia-key ",
      default_provider: " nvidia ",
      model: " deepseek-ai/deepseek-v4-pro ",
    },
    "C:\\config.json"
  );

  assert.equal(config.googleApiKey, "google-key");
  assert.equal(config.nvidiaApiKey, "nvidia-key");
  assert.equal(config.defaultProvider, "nvidia");
  assert.equal(config.defaultModel, "deepseek-ai/deepseek-v4-pro");
});

test("buildEnvRuntimeConfig maps deployment environment variables to runtime config fields", () => {
  assert.deepEqual(
    buildEnvRuntimeConfig({
      GOOGLE_API_KEY: " google-env-key ",
      NVIDIA_API_KEY: " nvidia-env-key ",
      DEFAULT_PROVIDER: " nvidia ",
      DEFAULT_MODEL: " deepseek-ai/deepseek-v4-pro ",
      DEFAULT_SYSTEM_PROMPT: "Be concise.",
    }),
    {
      api_key: "google-env-key",
      nvidia_api_key: "nvidia-env-key",
      default_provider: "nvidia",
      model: "deepseek-ai/deepseek-v4-pro",
      system_instruction: "Be concise.",
    }
  );
});

test("parseRuntimeConfig lets environment values override local config values", () => {
  const config = parseRuntimeConfig(
    {
      api_key: "local-google-key",
      nvidia_api_key: "local-nvidia-key",
      default_provider: "google",
      model: "gemini-2.5-pro",
      system_instruction: "Local prompt.",
    },
    "C:\\config.json",
    {
      GOOGLE_API_KEY: "env-google-key",
      NVIDIA_API_KEY: "env-nvidia-key",
      DEFAULT_PROVIDER: "nvidia",
      DEFAULT_MODEL: "deepseek-ai/deepseek-v4-pro",
      DEFAULT_SYSTEM_PROMPT: "Env prompt.",
    }
  );

  assert.equal(config.googleApiKey, "env-google-key");
  assert.equal(config.nvidiaApiKey, "env-nvidia-key");
  assert.equal(config.defaultProvider, "nvidia");
  assert.equal(config.defaultModel, "deepseek-ai/deepseek-v4-pro");
  assert.equal(config.defaultSystemPrompt, "Env prompt.");
});

test("parseDotEnv reads simple dotenv files without exposing comments", () => {
  assert.deepEqual(
    parseDotEnv(`
# ignored comment
GOOGLE_API_KEY=google-key
NVIDIA_API_KEY="nvidia-key"
EMPTY_VALUE=
DEFAULT_PROVIDER='nvidia'
MALFORMED_LINE
`),
    {
      GOOGLE_API_KEY: "google-key",
      NVIDIA_API_KEY: "nvidia-key",
      EMPTY_VALUE: "",
      DEFAULT_PROVIDER: "nvidia",
    }
  );
});


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
    () =>
      loadAuthConfig({
        ...VALID_AUTH_ENV,
        PUBLIC_ORIGIN: "https://philippeho.dev/philchat",
      }),
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
