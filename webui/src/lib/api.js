import { apiPath } from "./paths";

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON from ${response.url}, but received: ${text}`);
  }
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const payload = await parseJsonResponse(response);

  if (!response.ok) {
    const message = buildRequestErrorMessage(url, response.status, payload);
    const error = new Error(message);
    error.payload = payload;
    throw error;
  }

  return payload;
}

export function fetchBootstrap() {
  return fetchJson(apiPath("/api/bootstrap"));
}

export function fetchModels() {
  return fetchJson(apiPath("/api/models"));
}

export function fetchUsage() {
  return fetchJson(apiPath("/api/usage"));
}

export async function streamChatResponse({
  provider,
  modelId,
  systemPrompt,
  messages,
  signal,
  onEvent,
}) {
  const chatStreamPath = apiPath("/api/chat/stream");
  const response = await fetch(chatStreamPath, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      provider,
      modelId,
      systemPrompt,
      messages,
    }),
    signal,
  });

  if (!response.ok) {
    const payload = await parseJsonResponse(response);
    const message = buildRequestErrorMessage(chatStreamPath, response.status, payload);
    const error = new Error(message);
    error.payload = payload;
    throw error;
  }

  const reader = response.body.getReader();
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
        const event = parseEvent(rawEvent);
        if (event) {
          onEvent(event);
        }
      }

      boundaryIndex = buffer.indexOf("\n\n");
    }
  }
}

function parseEvent(rawEvent) {
  const lines = rawEvent.split("\n");
  const nameLine = lines.find((line) => line.startsWith("event:"));
  const dataLines = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());

  if (!nameLine || dataLines.length === 0) {
    return null;
  }

  return {
    name: nameLine.slice(6).trim(),
    payload: JSON.parse(dataLines.join("\n")),
  };
}

function buildRequestErrorMessage(url, status, payload) {
  if (payload?.message) {
    return payload.message;
  }

  if (status === 500 && url.startsWith("/api/")) {
    return "The local API server is not reachable. Start the combined dev server from D:\\GoogleModels\\webui with `npm run dev`, or start D:\\GoogleModels\\server separately.";
  }

  return `Request failed with HTTP ${status}.`;
}
