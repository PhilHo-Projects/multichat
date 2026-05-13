import { AppError } from "./config.js";

const NVIDIA_API_BASE = "https://integrate.api.nvidia.com/v1";
const NVIDIA_PROVIDER = "nvidia";
const NVIDIA_PROVIDER_LABEL = "NVIDIA";
const DEFAULT_REASONING_EFFORT = "high";
const DEFAULT_MAX_TOKENS = 1000;

export const NVIDIA_DEEPSEEK_V4_PRO_MODEL = {
  provider: NVIDIA_PROVIDER,
  providerLabel: NVIDIA_PROVIDER_LABEL,
  id: "deepseek-ai/deepseek-v4-pro",
  apiModelId: "deepseek-ai/deepseek-v4-pro",
  displayName: "DeepSeek V4 Pro",
  description: "OpenAI-compatible NVIDIA NIM endpoint for DeepSeek V4 Pro.",
  inputTokenLimit: 1_000_000,
  outputTokenLimit: 16_384,
  supportedGenerationMethods: ["chat.completions"],
  enabledForChat: true,
};

export async function fetchNvidiaModels(apiKey) {
  if (!apiKey) {
    throw new AppError("No NVIDIA API key was found in the runtime config.", {
      httpCode: 503,
      provider: NVIDIA_PROVIDER,
    });
  }

  return [{ ...NVIDIA_DEEPSEEK_V4_PRO_MODEL }];
}

export function createNvidiaChatRequestBody({
  modelId,
  systemPrompt,
  messages,
}) {
  const normalizedMessages = [];

  if (systemPrompt?.trim()) {
    normalizedMessages.push({
      role: "system",
      content: systemPrompt.trim(),
    });
  }

  for (const message of messages ?? []) {
    normalizedMessages.push(normalizeNvidiaRequestMessage(message, modelId));
  }

  return {
    model: modelId,
    stream: true,
    reasoning_effort: DEFAULT_REASONING_EFFORT,
    max_tokens: DEFAULT_MAX_TOKENS,
    messages: normalizedMessages,
  };
}

export async function openNvidiaChatStream({
  apiKey,
  modelId,
  systemPrompt,
  messages,
  signal,
}) {
  if (!apiKey) {
    throw new AppError("No NVIDIA API key was found in the runtime config.", {
      httpCode: 503,
      modelId,
      provider: NVIDIA_PROVIDER,
    });
  }

  if (!modelId?.trim()) {
    throw new AppError("A model must be selected before sending a prompt.", {
      httpCode: 400,
      provider: NVIDIA_PROVIDER,
    });
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    throw new AppError("At least one chat message is required.", {
      httpCode: 400,
      provider: NVIDIA_PROVIDER,
    });
  }

  const body = createNvidiaChatRequestBody({
    modelId,
    systemPrompt,
    messages,
  });

  const response = await fetch(`${NVIDIA_API_BASE}/chat/completions`, {
    method: "POST",
    headers: createNvidiaHeaders(apiKey),
    body: JSON.stringify(body),
    signal,
  }).catch((error) => {
    if (error.name === "AbortError") {
      throw error;
    }

    throw new AppError(`Network error connecting to NVIDIA: ${error.message}`, {
      httpCode: 502,
      modelId,
      provider: NVIDIA_PROVIDER,
    });
  });

  if (!response.ok) {
    const { json, text } = await parseResponseBody(response);
    const normalizedError = normalizeNvidiaError(json ?? text, response.status, modelId);
    throw new AppError(normalizedError.message, normalizedError);
  }

  return response;
}

export async function streamNvidiaSse(readableStream, handlers = {}) {
  const reader = readableStream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

    let boundaryIndex = buffer.indexOf("\n\n");
    while (boundaryIndex !== -1) {
      const rawEvent = buffer.slice(0, boundaryIndex).trim();
      buffer = buffer.slice(boundaryIndex + 2);

      if (rawEvent) {
        const payload = parseNvidiaSseEvent(rawEvent);
        if (payload) {
          await handlers.onChunk?.(payload);
        }
      }

      boundaryIndex = buffer.indexOf("\n\n");
    }
  }

  const finalChunk = buffer.trim();
  if (finalChunk) {
    const payload = parseNvidiaSseEvent(finalChunk);
    if (payload) {
      await handlers.onChunk?.(payload);
    }
  }
}

export function normalizeNvidiaStreamChunk(payload) {
  const text = (payload?.choices ?? [])
    .map((choice) => choice?.delta?.content ?? choice?.message?.content ?? "")
    .filter((part) => typeof part === "string" && part.length > 0)
    .join("");

  return {
    parts: text ? [{ type: "text", text }] : [],
    text,
    usage: normalizeNvidiaUsage(payload?.usage),
  };
}

function normalizeNvidiaRequestMessage(message, modelId) {
  const role = normalizeNvidiaRole(message?.role);
  const textParts = [];

  for (const part of message?.parts ?? []) {
    if (typeof part.text === "string") {
      textParts.push(part.text);
      continue;
    }

    if (part.inline_data || part.inlineData) {
      throw new AppError(
        "NVIDIA DeepSeek V4 Pro only supports text input in this tester. Remove image, audio, or PDF attachments and try again.",
        {
          httpCode: 400,
          modelId,
          provider: NVIDIA_PROVIDER,
        }
      );
    }

    throw new AppError("Only text message parts are supported by NVIDIA models.", {
      httpCode: 400,
      modelId,
      provider: NVIDIA_PROVIDER,
    });
  }

  if (textParts.length === 0) {
    throw new AppError("Every NVIDIA chat message must include text content.", {
      httpCode: 400,
      modelId,
      provider: NVIDIA_PROVIDER,
    });
  }

  return {
    role,
    content: textParts.join(""),
  };
}

function normalizeNvidiaRole(role) {
  const incomingRole = String(role ?? "").toLowerCase();

  if (incomingRole === "model") {
    return "assistant";
  }

  if (incomingRole === "assistant" || incomingRole === "user") {
    return incomingRole;
  }

  throw new AppError(`Unsupported chat role "${role}".`, {
    httpCode: 400,
    provider: NVIDIA_PROVIDER,
  });
}

function createNvidiaHeaders(apiKey) {
  return {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    Authorization: `Bearer ${apiKey}`,
  };
}

async function parseResponseBody(response) {
  const text = await response.text();
  if (!text) {
    return { text: "", json: null };
  }

  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: null };
  }
}

function normalizeNvidiaError(body, httpCode, modelId = null) {
  const upstreamError = body?.error ?? null;

  return {
    httpCode,
    googleStatus: upstreamError?.type ?? upstreamError?.code ?? null,
    message:
      upstreamError?.message ??
      (typeof body === "string" && body.trim().length > 0
        ? body
        : `NVIDIA API request failed with HTTP ${httpCode}.`),
    modelId,
    provider: NVIDIA_PROVIDER,
    details: upstreamError ?? null,
  };
}

function parseNvidiaSseEvent(rawEvent) {
  const dataLines = rawEvent
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());

  if (dataLines.length === 0) {
    return null;
  }

  const joinedData = dataLines.join("\n");
  if (!joinedData || joinedData === "[DONE]") {
    return null;
  }

  try {
    return JSON.parse(joinedData);
  } catch (error) {
    throw new AppError(`Failed to parse NVIDIA SSE chunk: ${error.message}`, {
      httpCode: 502,
      provider: NVIDIA_PROVIDER,
      details: { rawEvent },
    });
  }
}

function normalizeNvidiaUsage(usage) {
  if (!usage) {
    return null;
  }

  return {
    promptTokenCount:
      typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : null,
    candidatesTokenCount:
      typeof usage.completion_tokens === "number"
        ? usage.completion_tokens
        : null,
    totalTokenCount:
      typeof usage.total_tokens === "number" ? usage.total_tokens : null,
  };
}
