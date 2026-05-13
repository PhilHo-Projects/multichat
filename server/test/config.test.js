import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEnvRuntimeConfig,
  parseDotEnv,
  parseRuntimeConfig,
  normalizeAppBasePath,
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

test("normalizeAppBasePath returns a root or slash-wrapped mount path", () => {
  assert.equal(normalizeAppBasePath(""), "");
  assert.equal(normalizeAppBasePath("/"), "");
  assert.equal(normalizeAppBasePath("philchat"), "/philchat");
  assert.equal(normalizeAppBasePath("/philchat/"), "/philchat");
  assert.equal(normalizeAppBasePath(" /nested/path/ "), "/nested/path");
});
