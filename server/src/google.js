import { AppError } from "./config.js";

const GOOGLE_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

function createGoogleHeaders(apiKey, extraHeaders = {}) {
  return {
    "Content-Type": "application/json",
    "x-goog-api-key": apiKey,
    ...extraHeaders,
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

export function normalizeGoogleError(body, httpCode, modelId = null) {
  const googleError = body?.error ?? null;

  return {
    httpCode,
    googleStatus: googleError?.status ?? null,
    message:
      googleError?.message ??
      (typeof body === "string" && body.trim().length > 0
        ? body
        : `Google API request failed with HTTP ${httpCode}.`),
    modelId,
    details: googleError?.details ?? null,
  };
}

export function normalizeModel(rawModel) {
  const id = String(rawModel.name ?? "").replace(/^models\//, "");
  const methods = Array.isArray(rawModel.supportedGenerationMethods)
    ? rawModel.supportedGenerationMethods
    : [];

  return {
    id,
    displayName: rawModel.displayName?.trim() || id,
    description: rawModel.description?.trim() || "",
    inputTokenLimit:
      typeof rawModel.inputTokenLimit === "number" ? rawModel.inputTokenLimit : null,
    outputTokenLimit:
      typeof rawModel.outputTokenLimit === "number" ? rawModel.outputTokenLimit : null,
    supportedGenerationMethods: methods,
    enabledForChat: methods.includes("generateContent"),
  };
}

export async function verifyGoogleConnection(apiKey) {
  if (!apiKey) {
    return {
      canConnect: false,
      error: {
        httpCode: 503,
        googleStatus: null,
        message: "No API key was found in the runtime config.",
        modelId: null,
        details: null,
      },
    };
  }

  try {
    await fetchModels(apiKey);
    return { canConnect: true, error: null };
  } catch (error) {
    if (error instanceof AppError) {
      return {
        canConnect: false,
        error: {
          httpCode: error.httpCode,
          googleStatus: error.googleStatus,
          message: error.message,
          modelId: error.modelId,
          details: error.details,
        },
      };
    }

    return {
      canConnect: false,
      error: {
        httpCode: 500,
        googleStatus: null,
        message: error.message,
        modelId: null,
        details: null,
      },
    };
  }
}

export async function fetchModels(apiKey) {
  if (!apiKey) {
    throw new AppError("No API key was found in the runtime config.", {
      httpCode: 503,
    });
  }

  const response = await fetch(`${GOOGLE_API_BASE}/models`, {
    headers: createGoogleHeaders(apiKey),
  }).catch((error) => {
    throw new AppError(`Network error connecting to Google: ${error.message}`, {
      httpCode: 502,
    });
  });

  const { json, text } = await parseResponseBody(response);

  if (!response.ok) {
    const normalizedError = normalizeGoogleError(json ?? text, response.status);
    throw new AppError(normalizedError.message, normalizedError);
  }

  const models = Array.isArray(json?.models) ? json.models.map(normalizeModel) : [];
  models.sort((left, right) => left.displayName.localeCompare(right.displayName));
  return models;
}

function normalizeRequestMessage(message) {
  const incomingRole = String(message.role ?? "").toLowerCase();
  const role = incomingRole === "assistant" ? "model" : incomingRole;

  if (!["user", "model"].includes(role)) {
    throw new AppError(`Unsupported chat role "${message.role}".`, { httpCode: 400 });
  }

  if (!Array.isArray(message.parts) || message.parts.length === 0) {
    throw new AppError("Every chat message must include a non-empty parts array.", {
      httpCode: 400,
    });
  }

  const parts = message.parts
    .map((part) => {
      if (typeof part.text === "string") {
        return { text: part.text };
      }

      const inlineData = part.inline_data ?? part.inlineData;
      if (
        inlineData &&
        typeof inlineData.data === "string" &&
        inlineData.data.length > 0 &&
        typeof (inlineData.mime_type ?? inlineData.mimeType) === "string"
      ) {
        return {
          inline_data: {
            mime_type: inlineData.mime_type ?? inlineData.mimeType,
            data: inlineData.data,
          },
        };
      }

      return null;
    })
    .filter(Boolean);

  if (parts.length === 0) {
    throw new AppError(
      "Only text parts are supported by this v1 tester request format.",
      { httpCode: 400 }
    );
  }

  return { role, parts };
}

function createChatRequestBody({ modelId, systemPrompt, messages, inlineSystemPrompt }) {
  const contents = messages.map(normalizeRequestMessage);
  const body = { contents };

  if (!systemPrompt?.trim()) {
    return body;
  }

  if (!inlineSystemPrompt) {
    body.systemInstruction = {
      parts: [{ text: systemPrompt }],
    };
    return body;
  }

  const firstUserIndex = contents.findIndex((message) => message.role === "user");
  const inlinePrefix =
    `System instruction for this conversation:\n${systemPrompt}\n\n` +
    "Apply that instruction while responding to the user's message below.\n\n";

  if (firstUserIndex === -1) {
    contents.unshift({
      role: "user",
      parts: [{ text: inlinePrefix }],
    });
    return body;
  }

  const firstUserMessage = contents[firstUserIndex];
  const [firstPart, ...remainingParts] = firstUserMessage.parts;
  contents[firstUserIndex] = {
    ...firstUserMessage,
    parts: [
      {
        text: `${inlinePrefix}${firstPart.text}`,
      },
      ...remainingParts,
    ],
  };

  return body;
}

async function sendChatRequest({ apiKey, modelId, body, signal }) {
  const response = await fetch(
    `${GOOGLE_API_BASE}/models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse`,
    {
      method: "POST",
      headers: createGoogleHeaders(apiKey),
      body: JSON.stringify(body),
      signal,
    }
  ).catch((error) => {
    if (error.name === "AbortError") {
      throw error;
    }

    throw new AppError(`Network error connecting to Google: ${error.message}`, {
      httpCode: 502,
      modelId,
    });
  });

  if (!response.ok) {
    const { json, text } = await parseResponseBody(response);
    const normalizedError = normalizeGoogleError(json ?? text, response.status, modelId);
    throw new AppError(normalizedError.message, normalizedError);
  }

  return response;
}

function shouldRetryWithoutDeveloperInstruction(error, systemPrompt) {
  return Boolean(
    systemPrompt?.trim() &&
      error instanceof AppError &&
      error.httpCode === 400 &&
      error.googleStatus === "INVALID_ARGUMENT" &&
      /developer instruction is not enabled/i.test(error.message)
  );
}

export async function openChatStream({
  apiKey,
  modelId,
  systemPrompt,
  messages,
  signal,
}) {
  if (!apiKey) {
    throw new AppError("No API key was found in the runtime config.", {
      httpCode: 503,
      modelId,
    });
  }

  if (!modelId?.trim()) {
    throw new AppError("A model must be selected before sending a prompt.", {
      httpCode: 400,
    });
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    throw new AppError("At least one chat message is required.", { httpCode: 400 });
  }

  const requestBody = createChatRequestBody({
    modelId,
    systemPrompt,
    messages,
    inlineSystemPrompt: false,
  });

  try {
    return await sendChatRequest({
      apiKey,
      modelId,
      body: requestBody,
      signal,
    });
  } catch (error) {
    if (!shouldRetryWithoutDeveloperInstruction(error, systemPrompt)) {
      throw error;
    }

    const fallbackBody = createChatRequestBody({
      modelId,
      systemPrompt,
      messages,
      inlineSystemPrompt: true,
    });

    return sendChatRequest({
      apiKey,
      modelId,
      body: fallbackBody,
      signal,
    });
  }
}
