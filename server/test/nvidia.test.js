import assert from "node:assert/strict";
import test from "node:test";

import { AppError } from "../src/config.js";
import {
  NVIDIA_DEEPSEEK_V4_PRO_MODEL,
  createNvidiaChatRequestBody,
  fetchNvidiaModels,
  normalizeNvidiaStreamChunk,
} from "../src/nvidia.js";

test("fetchNvidiaModels exposes DeepSeek V4 Pro as a chat-capable NVIDIA model", async () => {
  const models = await fetchNvidiaModels("nvidia-key");

  assert.deepEqual(models, [
    {
      provider: "nvidia",
      providerLabel: "NVIDIA",
      id: "deepseek-ai/deepseek-v4-pro",
      apiModelId: "deepseek-ai/deepseek-v4-pro",
      displayName: "DeepSeek V4 Pro",
      description:
        "OpenAI-compatible NVIDIA NIM endpoint for DeepSeek V4 Pro.",
      inputTokenLimit: 1_000_000,
      outputTokenLimit: 16_384,
      supportedGenerationMethods: ["chat.completions"],
      enabledForChat: true,
    },
  ]);
  assert.equal(NVIDIA_DEEPSEEK_V4_PRO_MODEL.provider, "nvidia");
});

test("createNvidiaChatRequestBody maps tester messages to OpenAI chat messages", () => {
  const body = createNvidiaChatRequestBody({
    modelId: "deepseek-ai/deepseek-v4-pro",
    systemPrompt: "Answer briefly.",
    messages: [
      {
        role: "user",
        parts: [{ text: "Hello" }],
      },
      {
        role: "model",
        parts: [{ text: "Hi." }],
      },
      {
        role: "user",
        parts: [{ text: "Continue" }],
      },
    ],
  });

  assert.deepEqual(body, {
    model: "deepseek-ai/deepseek-v4-pro",
    stream: true,
    reasoning_effort: "high",
    max_tokens: 1000,
    messages: [
      { role: "system", content: "Answer briefly." },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi." },
      { role: "user", content: "Continue" },
    ],
  });
});

test("createNvidiaChatRequestBody rejects inline attachments because DeepSeek V4 Pro is text-only", () => {
  assert.throws(
    () =>
      createNvidiaChatRequestBody({
        modelId: "deepseek-ai/deepseek-v4-pro",
        systemPrompt: "",
        messages: [
          {
            role: "user",
            parts: [
              {
                inline_data: {
                  mime_type: "image/png",
                  data: "abc",
                },
              },
            ],
          },
        ],
      }),
    (error) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.httpCode, 400);
      assert.match(error.message, /only supports text input/i);
      return true;
    }
  );
});

test("normalizeNvidiaStreamChunk maps OpenAI streaming deltas and usage to local parts", () => {
  const normalized = normalizeNvidiaStreamChunk({
    choices: [
      {
        delta: {
          content: "Hello from NVIDIA",
        },
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 4,
      total_tokens: 14,
    },
  });

  assert.deepEqual(normalized, {
    parts: [{ type: "text", text: "Hello from NVIDIA" }],
    text: "Hello from NVIDIA",
    usage: {
      promptTokenCount: 10,
      candidatesTokenCount: 4,
      totalTokenCount: 14,
    },
  });
});
