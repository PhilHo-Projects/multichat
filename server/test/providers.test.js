import assert from "node:assert/strict";
import test from "node:test";

import {
  decorateGoogleModel,
  resolveProviderForModel,
} from "../src/providers.js";

test("decorateGoogleModel adds provider metadata without changing Google model identity", () => {
  const model = decorateGoogleModel({
    id: "gemini-2.5-pro",
    displayName: "Gemini 2.5 Pro",
    enabledForChat: true,
  });

  assert.deepEqual(model, {
    provider: "google",
    providerLabel: "Google",
    id: "gemini-2.5-pro",
    apiModelId: "gemini-2.5-pro",
    displayName: "Gemini 2.5 Pro",
    enabledForChat: true,
  });
});

test("resolveProviderForModel honors explicit provider before model id inference", () => {
  assert.equal(
    resolveProviderForModel({
      provider: "nvidia",
      modelId: "gemini-2.5-pro",
    }),
    "nvidia"
  );

  assert.equal(
    resolveProviderForModel({
      provider: "",
      modelId: "deepseek-ai/deepseek-v4-pro",
    }),
    "nvidia"
  );

  assert.equal(
    resolveProviderForModel({
      provider: "",
      modelId: "gemini-2.5-pro",
    }),
    "google"
  );
});
