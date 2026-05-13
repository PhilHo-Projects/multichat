import { AppError } from "./config.js";

export function sendSseEvent(response, eventName, payload) {
  response.write(`event: ${eventName}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export async function streamGoogleSse(readableStream, handlers = {}) {
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
        const payload = parseSseEvent(rawEvent);
        if (payload) {
          await handlers.onChunk?.(payload);
        }
      }

      boundaryIndex = buffer.indexOf("\n\n");
    }
  }

  const finalChunk = buffer.trim();
  if (finalChunk) {
    const payload = parseSseEvent(finalChunk);
    if (payload) {
      await handlers.onChunk?.(payload);
    }
  }
}

function parseSseEvent(rawEvent) {
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
    throw new AppError(`Failed to parse Google SSE chunk: ${error.message}`, {
      httpCode: 502,
      details: { rawEvent },
    });
  }
}

export function normalizeResponseParts(parts = []) {
  return parts.map((part) => {
    if (typeof part.text === "string") {
      return {
        type: "text",
        text: part.text,
      };
    }

    return {
      type: "unsupported",
      label: Object.keys(part ?? {}).join(", ") || "unknown part",
      raw: part,
    };
  });
}

