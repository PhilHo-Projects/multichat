/* eslint-disable react/prop-types */
import { marked } from "marked";
import DOMPurify from "dompurify";
import { useEffect } from "react";

import BotIcon from "./icons/BotIcon";
import "../styles/Chat.css";

function render(text) {
  return DOMPurify.sanitize(marked.parse(text));
}

function joinTextParts(parts = []) {
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function getAttachmentParts(parts = []) {
  return parts.filter((part) => part.type === "attachment");
}

function formatBytes(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  );
  const value = bytes / 1024 ** exponent;
  const precision = exponent === 0 ? 0 : value >= 10 ? 1 : 2;

  return `${value.toFixed(precision)} ${units[exponent]}`;
}

function attachmentKindLabel(kind) {
  switch (kind) {
    case "image":
      return "Image";
    case "audio":
      return "Audio";
    case "pdf":
      return "PDF";
    case "text":
      return "Text";
    default:
      return "File";
  }
}

/**
 * Chat component renders a chat interface with messages.
 */
export default function Chat({ messages }) {
  const empty = messages.length === 0;

  useEffect(() => {
    window.MathJax.typeset();
  }, [messages]);

  return (
    <div
      className={`flex-1 p-6 max-w-[960px] w-full ${
        empty ? "flex flex-col items-center justify-end" : "space-y-5"
      }`}
    >
      {empty ? (
        <div className="text-xl">
          <span className="text-zinc-500">
            Pick a model and start testing.
          </span>
        </div>
      ) : (
        messages.map((msg, i) => (
          <div
            key={`message-${i}`}
            className={
              msg.role === "notice"
                ? "w-full"
                : "flex items-start space-x-4"
            }
          >
            {msg.role === "assistant" ? (
              <>
                <BotIcon className="mt-2 h-6 w-6 min-h-6 min-w-6 text-zinc-500" />
                <div className="max-w-[78ch] rounded-[24px] border border-white/10 bg-[#1f1f1f] p-4 text-zinc-100 shadow-sm">
                  <p className="min-h-6 overflow-wrap-anywhere text-zinc-100">
                    {joinTextParts(msg.parts).length > 0 ? (
                      <span
                        className="markdown"
                        dangerouslySetInnerHTML={{
                          __html: render(joinTextParts(msg.parts)),
                        }}
                      />
                    ) : msg.pending ? (
                      <span className="h-6 flex items-center gap-1">
                        <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-zinc-400"></span>
                        <span className="animation-delay-200 h-2.5 w-2.5 animate-pulse rounded-full bg-zinc-400"></span>
                        <span className="animation-delay-400 h-2.5 w-2.5 animate-pulse rounded-full bg-zinc-400"></span>
                      </span>
                    ) : (
                      <span className="text-sm text-zinc-500">
                        No text returned.
                      </span>
                    )}
                  </p>
                  {msg.parts
                    .filter((part) => part.type === "unsupported")
                    .map((part, partIndex) => (
                      <div
                        key={`assistant-part-${partIndex}`}
                        className="mt-3 rounded-2xl border border-dashed border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-zinc-300"
                      >
                        Unsupported response part returned: {part.label}
                      </div>
                    ))}
                </div>
              </>
            ) : msg.role === "user" ? (
              <div className="ml-auto max-w-[78ch] rounded-[24px] border border-white/10 bg-[#2a2a2a] p-4 text-zinc-100">
                {joinTextParts(msg.parts).length > 0 && (
                  <p className="min-h-6 overflow-wrap-anywhere">
                    {joinTextParts(msg.parts)}
                  </p>
                )}
                {getAttachmentParts(msg.parts).length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {getAttachmentParts(msg.parts).map((attachment) => (
                      <div
                        key={attachment.id || `${attachment.name}-${attachment.size}`}
                        className="flex max-w-full items-center gap-2 rounded-2xl border border-white/10 bg-black/20 px-3 py-2"
                      >
                        <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] text-zinc-400">
                          {attachmentKindLabel(attachment.kind)}
                        </span>
                        <div className="min-w-0">
                          <p className="truncate text-sm text-zinc-100">{attachment.name}</p>
                          <p className="text-xs text-zinc-500">
                            {formatBytes(attachment.size)}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div
                className={`rounded-[22px] border px-4 py-3 text-sm ${
                  msg.variant === "quota"
                    ? "border-amber-500/30 bg-amber-500/10 text-amber-100"
                    : "border-red-500/30 bg-red-500/10 text-red-100"
                }`}
              >
                <p className="font-semibold">{msg.title}</p>
                <p className="mt-1 whitespace-pre-wrap">{msg.body}</p>
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}
