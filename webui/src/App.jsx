import { useEffect, useRef, useState } from "react";

import Chat from "./components/Chat";
import LoginModal from "./components/LoginModal";
import UsagePanel from "./components/UsagePanel";
import ArrowRightIcon from "./components/icons/ArrowRightIcon";
import ArrowUpIcon from "./components/icons/ArrowUpIcon";
import GearIcon from "./components/icons/GearIcon";
import SidebarIcon from "./components/icons/SidebarIcon";
import StopIcon from "./components/icons/StopIcon";
import {
  fetchBootstrap,
  fetchMe,
  fetchModels,
  fetchUsage,
  login,
  logout,
  streamChatResponse,
} from "./lib/api";

const STICKY_SCROLL_THRESHOLD = 120;
const USAGE_REFRESH_INTERVAL_MS = 90_000;
const USAGE_STALE_AFTER_MS = 5 * 60 * 1000;
const MAX_PENDING_ATTACHMENT_BYTES = 18 * 1024 * 1024;
const MAX_TEXT_ATTACHMENT_BYTES = 768 * 1024;
const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful AI assistant. Answer clearly and concisely. If you are unsure, say so.";
const PROVIDER_LABELS = {
  google: "Google",
  nvidia: "NVIDIA",
};
const PROVIDER_ORDER = ["google", "nvidia"];
const ATTACHMENT_PICKERS = [
  {
    id: "images",
    label: "Images",
    accept: "image/*",
  },
  {
    id: "audio",
    label: "Audio files",
    accept: "audio/*",
  },
  {
    id: "text",
    label: "Text files",
    accept:
      ".txt,.md,.markdown,.csv,.json,.js,.jsx,.ts,.tsx,.py,.html,.css,.xml,.yaml,.yml,.log,text/*,application/json",
  },
  {
    id: "pdf",
    label: "PDF files",
    accept: ".pdf,application/pdf",
  },
];

function createChatSession() {
  return {
    id:
      globalThis.crypto?.randomUUID?.() ??
      `chat-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    title: "New chat",
    preview: "Start typing to begin.",
    messages: [],
    usage: null,
    lastRunSummary: null,
    selectedModelId: "",
    updatedAt: new Date().toISOString(),
  };
}

const INITIAL_CHAT_SESSION = createChatSession();

function createUserMessage(parts) {
  return {
    role: "user",
    parts,
  };
}

function createAssistantPlaceholder() {
  return {
    role: "assistant",
    pending: true,
    parts: [{ type: "text", text: "" }],
  };
}

function toApiMessage(message) {
  const visibleTextParts = message.parts.filter(
    (part) => part.type === "text" && part.text.trim().length > 0
  );
  const hasAttachments = message.parts.some((part) => part.type === "attachment");
  const attachmentApiParts = [];
  const textApiParts = [];

  for (const part of message.parts) {
    if (part.type === "attachment") {
      if (part.transport === "text") {
        attachmentApiParts.push({
          text:
            `Attached file: ${part.name}\n` +
            `Mime type: ${part.mimeType}\n` +
            "---BEGIN FILE---\n" +
            `${part.textContent}\n` +
            "---END FILE---",
        });
      } else if (part.transport === "inline_data") {
        attachmentApiParts.push({
          inline_data: {
            mime_type: part.mimeType,
            data: part.data,
          },
        });
      }

      continue;
    }

    if (part.type === "text") {
      textApiParts.push({ text: part.text });
    }
  }

  const normalizedParts = [...attachmentApiParts, ...textApiParts];

  if (visibleTextParts.length === 0 && hasAttachments) {
    normalizedParts.push({
      text:
        message.parts.filter((part) => part.type === "attachment").length === 1
          ? "Please analyze the attached file."
          : "Please analyze the attached files.",
    });
  }

  return {
    role: message.role === "assistant" ? "model" : message.role,
    parts: normalizedParts,
  };
}

function mergeParts(existingParts, incomingParts) {
  const merged = [...existingParts];

  for (const part of incomingParts || []) {
    if (part.type === "text") {
      const lastPart = merged.at(-1);
      if (lastPart?.type === "text") {
        lastPart.text += part.text;
      } else {
        merged.push({ ...part });
      }
      continue;
    }

    merged.push(part);
  }

  return merged;
}

function findSelectedModel(models, selectedModelId) {
  return models.find((model) => model.id === selectedModelId) ?? null;
}

function modelProvider(model) {
  return model?.provider || "google";
}

function modelProviderLabel(model) {
  const provider = modelProvider(model);
  return model?.providerLabel || PROVIDER_LABELS[provider] || provider;
}

function groupModelsByProvider(models) {
  const groups = new Map();

  for (const model of models) {
    const provider = modelProvider(model);
    if (!groups.has(provider)) {
      groups.set(provider, {
        provider,
        providerLabel: modelProviderLabel(model),
        models: [],
      });
    }

    groups.get(provider).models.push(model);
  }

  return Array.from(groups.values()).sort((left, right) => {
    const leftIndex = PROVIDER_ORDER.indexOf(left.provider);
    const rightIndex = PROVIDER_ORDER.indexOf(right.provider);
    const normalizedLeftIndex = leftIndex === -1 ? PROVIDER_ORDER.length : leftIndex;
    const normalizedRightIndex = rightIndex === -1 ? PROVIDER_ORDER.length : rightIndex;

    if (normalizedLeftIndex !== normalizedRightIndex) {
      return normalizedLeftIndex - normalizedRightIndex;
    }

    return left.providerLabel.localeCompare(right.providerLabel);
  });
}

function modelGroupLabel(group) {
  return group.provider === "google" ? "Models" : group.providerLabel;
}

function pickInitialModel(models, preferredModelId) {
  if (preferredModelId && models.some((model) => model.id === preferredModelId)) {
    return preferredModelId;
  }

  return models.find((model) => model.enabledForChat)?.id ?? models[0]?.id ?? "";
}

function formatNumber(value) {
  if (typeof value !== "number") {
    return "n/a";
  }

  return new Intl.NumberFormat().format(value);
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

function formatCheckedAt(value) {
  if (!value) {
    return "n/a";
  }

  return new Date(value).toLocaleTimeString();
}

function formatSessionTime(value) {
  if (!value) {
    return "";
  }

  return new Date(value).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function joinTextParts(parts = []) {
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
    .trim();
}

function getAttachmentParts(parts = []) {
  return parts.filter((part) => part.type === "attachment");
}

function summarizeAttachmentParts(parts = []) {
  const attachments = getAttachmentParts(parts);

  if (attachments.length === 0) {
    return "";
  }

  if (attachments.length === 1) {
    return attachments[0].name;
  }

  return `${attachments.length} files`;
}

function buildChatSessionTitle(messages) {
  const firstUserMessage = messages.find((message) => message.role === "user");
  const title = joinTextParts(firstUserMessage?.parts ?? []);
  const attachmentTitle = summarizeAttachmentParts(firstUserMessage?.parts ?? []);

  if (!title) {
    if (!attachmentTitle) {
      return "New chat";
    }

    return attachmentTitle.length > 42
      ? `${attachmentTitle.slice(0, 42)}...`
      : attachmentTitle;
  }

  return title.length > 42 ? `${title.slice(0, 42)}...` : title;
}

function buildChatSessionPreview(messages) {
  const latestMessage = [...messages]
    .reverse()
    .find((message) => message.role === "assistant" || message.role === "user");
  const preview = joinTextParts(latestMessage?.parts ?? []);
  const attachmentPreview = summarizeAttachmentParts(latestMessage?.parts ?? []);

  if (!preview) {
    if (!attachmentPreview) {
      return "Start typing to begin.";
    }

    return attachmentPreview;
  }

  return preview.length > 68 ? `${preview.slice(0, 68)}...` : preview;
}

function isTextAttachment(file) {
  const type = String(file.type || "").toLowerCase();
  const name = file.name.toLowerCase();

  return (
    type.startsWith("text/") ||
    type.includes("json") ||
    type.includes("xml") ||
    [
      ".txt",
      ".md",
      ".markdown",
      ".csv",
      ".json",
      ".js",
      ".jsx",
      ".ts",
      ".tsx",
      ".py",
      ".html",
      ".css",
      ".xml",
      ".yaml",
      ".yml",
      ".log",
    ].some((extension) => name.endsWith(extension))
  );
}

function detectAttachmentKind(file) {
  const type = String(file.type || "").toLowerCase();
  const name = file.name.toLowerCase();

  if (type.startsWith("image/")) {
    return "image";
  }

  if (type.startsWith("audio/")) {
    return "audio";
  }

  if (type === "application/pdf" || name.endsWith(".pdf")) {
    return "pdf";
  }

  if (isTextAttachment(file)) {
    return "text";
  }

  return null;
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

function createAttachmentId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `attachment-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  );
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const [, base64 = ""] = result.split(",");
      resolve(base64);
    };

    reader.onerror = () => {
      reject(reader.error || new Error(`Could not read ${file.name}.`));
    };

    reader.readAsDataURL(file);
  });
}

function matchesModelQuery(model, query) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return true;
  }

  const haystack = [
    model.provider,
    model.providerLabel,
    model.displayName,
    model.id,
    model.description,
    ...(model.supportedGenerationMethods || []),
  ]
    .join(" ")
    .toLowerCase();

  return haystack.includes(normalizedQuery);
}

function isQuotaError(error) {
  return error?.httpCode === 429 || error?.googleStatus === "RESOURCE_EXHAUSTED";
}

function buildNoticeMessage(error, modelId) {
  if (isQuotaError(error)) {
    const quotaNote =
      error?.provider === "nvidia"
        ? "NVIDIA API trial and rate limits are enforced by NVIDIA for the selected model."
        : "Gemini API rate limits are enforced per project. Daily request quotas reset at midnight Pacific time.";

    return {
      role: "notice",
      variant: "quota",
      title: `Quota reached for ${modelId}`,
      body: `${error.message}\n\n${quotaNote}`,
    };
  }

  if (error?.httpCode === 404) {
    return {
      role: "notice",
      variant: "error",
      title: `Model unavailable: ${modelId}`,
      body: `${error.message}\n\nRefresh the model list and choose another model.`,
    };
  }

  return {
    role: "notice",
    variant: "error",
    title: `Request failed for ${modelId}`,
    body: error?.message || "The model request failed.",
  };
}

function createBootstrapProblem(bootstrap) {
  if (!bootstrap) {
    return null;
  }

  const providers = bootstrap.providers ?? {
    google: bootstrap.google,
    nvidia: bootstrap.nvidia,
  };
  const providerStatuses = Object.values(providers).filter(Boolean);
  const hasReadyProvider = providerStatuses.some(
    (provider) => provider.keyPresent && provider.canConnect
  );

  if (!bootstrap.keySource.readable) {
    return {
      title: "Runtime config unavailable",
      message:
        bootstrap.google?.error?.message ||
        `The runtime config could not be read from ${bootstrap.keySource.path}.`,
    };
  }

  if (!bootstrap.keySource.present) {
    return {
      title: "No API key configured",
      message: `No Google or NVIDIA API key was found in ${bootstrap.keySource.path}.`,
    };
  }

  if (!hasReadyProvider) {
    const defaultProvider = bootstrap.defaults?.provider || "google";
    const status = providers[defaultProvider] ?? bootstrap.google;
    const label = PROVIDER_LABELS[defaultProvider] || "Provider";

    return {
      title: `${label} connection blocked`,
      message:
        status?.error?.message ||
        "The server could not validate any configured provider key.",
    };
  }

  return null;
}

function assistantHasContent(message) {
  if (!message || message.role !== "assistant") {
    return false;
  }

  return message.parts.some((part) => {
    if (part.type === "text") {
      return part.text.trim().length > 0;
    }

    return true;
  });
}

function modelChipLabel(model) {
  if (!model) {
    return "Select model";
  }

  return `${modelProviderLabel(model)}: ${model.displayName || model.id}`;
}

function normalizeQuotaModelId(modelId) {
  if (typeof modelId !== "string") {
    return "";
  }

  return modelId.replace(/^models\//, "").trim().toLowerCase();
}

function compareQuotaItems(left, right) {
  const leftScore = left.exhausted ? 2 : left.nearLimit ? 1 : 0;
  const rightScore = right.exhausted ? 2 : right.nearLimit ? 1 : 0;
  if (leftScore !== rightScore) {
    return rightScore - leftScore;
  }

  return (right.usagePercent ?? -1) - (left.usagePercent ?? -1);
}

function buildSelectedQuotaState(usageDashboard, selectedModel) {
  if (modelProvider(selectedModel) !== "google") {
    return null;
  }

  if (!usageDashboard || usageDashboard.status !== "ok") {
    return null;
  }

  const selectedModelId = selectedModel?.id ?? "";
  const normalizedSelectedModelId = normalizeQuotaModelId(selectedModelId);
  const relevantItems = usageDashboard.items
    .filter((item) => {
      if (!item.modelId) {
        return true;
      }

      return normalizeQuotaModelId(item.modelId) === normalizedSelectedModelId;
    })
    .sort(compareQuotaItems);

  if (relevantItems.length === 0) {
    return null;
  }

  const checkedAt = usageDashboard.checkedAt;
  const checkedAtTime = checkedAt ? Date.parse(checkedAt) : Number.NaN;
  const isFresh =
    Number.isFinite(checkedAtTime) &&
    Date.now() - checkedAtTime <= USAGE_STALE_AFTER_MS;

  return {
    items: relevantItems,
    topItem: relevantItems[0],
    exhausted: relevantItems.some((item) => item.exhausted),
    nearLimit: relevantItems.some((item) => item.nearLimit),
    isFresh,
    checkedAt,
  };
}

function buildUsageFetchFailure(bootstrap, error) {
  return {
    status: "error",
    projectId: bootstrap?.usage?.projectId || null,
    service: bootstrap?.usage?.service || "generativelanguage.googleapis.com",
    checkedAt: new Date().toISOString(),
    auth: {
      method: "application_default_credentials",
      credentialType: null,
      principalEmail: null,
    },
    summary: {
      totalItems: 0,
      exhaustedCount: 0,
      nearLimitCount: 0,
      modelCount: 0,
      projectWideCount: 0,
    },
    items: [],
    modelSummaries: [],
    setup: {
      instructions: [],
    },
    error: {
      message: error.payload?.message || error.message,
    },
  };
}

function getConnectionStatusMeta(bootstrap, provider = "google") {
  const providers = bootstrap?.providers ?? {
    google: bootstrap?.google,
    nvidia: bootstrap?.nvidia,
  };
  const status = providers?.[provider] ?? bootstrap?.google;
  const label = PROVIDER_LABELS[provider] || "Provider";
  const canConnect = Boolean(status?.canConnect);

  return {
    canConnect,
    label: canConnect ? `${label} ready` : `${label} blocked`,
    title: canConnect
      ? `${label} connection ready. Checked ${formatCheckedAt(status?.checkedAt)}.`
      : status?.error?.message || "The current provider connection is blocked.",
  };
}

function App() {
  const textareaRef = useRef(null);
  const chatContainerRef = useRef(null);
  const composerDockRef = useRef(null);
  const requestAbortRef = useRef(null);
  const dragCounterRef = useRef(0);
  const attachmentMenuRef = useRef(null);
  const imageInputRef = useRef(null);
  const audioInputRef = useRef(null);
  const textInputRef = useRef(null);
  const pdfInputRef = useRef(null);

  const [isInitializing, setIsInitializing] = useState(true);
  const [isRefreshingModels, setIsRefreshingModels] = useState(false);
  const [bootstrap, setBootstrap] = useState(null);
  const [authUser, setAuthUser] = useState(null);
  const [authEnabled, setAuthEnabled] = useState(false);
  const [guestMessagesUsed, setGuestMessagesUsed] = useState(0);
  const [guestMessagesLimit, setGuestMessagesLimit] = useState(5);
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [loginLimitReached, setLoginLimitReached] = useState(false);
  const [models, setModels] = useState([]);
  const [selectedModelId, setSelectedModelId] = useState("");
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_SYSTEM_PROMPT);
  const [modelSearchQuery, setModelSearchQuery] = useState("");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState(INITIAL_CHAT_SESSION.messages);
  const [usage, setUsage] = useState(null);
  const [usageDashboard, setUsageDashboard] = useState(null);
  const [isRunning, setIsRunning] = useState(false);
  const [isRefreshingUsage, setIsRefreshingUsage] = useState(false);
  const [isAttachmentMenuOpen, setIsAttachmentMenuOpen] = useState(false);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [isProcessingAttachments, setIsProcessingAttachments] = useState(false);
  const [topError, setTopError] = useState(null);
  const [lastRunSummary, setLastRunSummary] = useState(null);
  const [pendingAttachments, setPendingAttachments] = useState([]);
  const [showConfigDrawer, setShowConfigDrawer] = useState(false);
  const [isModelPickerOpen, setIsModelPickerOpen] = useState(false);
  const [showHistorySidebar, setShowHistorySidebar] = useState(false);
  const [chatSessions, setChatSessions] = useState([INITIAL_CHAT_SESSION]);
  const [activeSessionId, setActiveSessionId] = useState(INITIAL_CHAT_SESSION.id);
  const [composerDockHeight, setComposerDockHeight] = useState(280);

  const selectedModel = findSelectedModel(models, selectedModelId);
  const filteredModels = models.filter((model) =>
    matchesModelQuery(model, modelSearchQuery)
  );
  const filteredModelGroups = groupModelsByProvider(filteredModels);
  const bootstrapProblem = createBootstrapProblem(bootstrap);
  const chatEnabled = Boolean(
    !bootstrapProblem && selectedModel && selectedModel.enabledForChat
  );
  const selectedQuotaState = buildSelectedQuotaState(
    usageDashboard,
    selectedModel
  );
  const sendBlockedByQuota = Boolean(
    selectedQuotaState?.exhausted && selectedQuotaState?.isFresh
  );
  const sendEnabled = chatEnabled && !sendBlockedByQuota;
  const connectionStatus = getConnectionStatusMeta(
    bootstrap,
    selectedModel ? modelProvider(selectedModel) : bootstrap?.defaults?.provider || "google"
  );
  const isEmptyState = messages.length === 0;
  const canSendMessage = Boolean(
    sendEnabled &&
      (input.trim().length > 0 || pendingAttachments.length > 0) &&
      !isProcessingAttachments
  );

  useEffect(() => {
    initializeApp();

    return () => {
      requestAbortRef.current?.abort();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      loadUsage({ silent: true });
    }, USAGE_REFRESH_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [bootstrap]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    resizeInput();
  }, [input]);

  useEffect(() => {
    if (!showConfigDrawer) {
      setIsModelPickerOpen(false);
      setModelSearchQuery("");
    }
  }, [showConfigDrawer]);

  useEffect(() => {
    if (!isAttachmentMenuOpen) {
      return;
    }

    function handlePointerDown(event) {
      if (attachmentMenuRef.current?.contains(event.target)) {
        return;
      }

      setIsAttachmentMenuOpen(false);
    }

    function handleEscape(event) {
      if (event.key === "Escape") {
        setIsAttachmentMenuOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isAttachmentMenuOpen]);

  useEffect(() => {
    setChatSessions((previousSessions) => {
      const currentSession =
        previousSessions.find((session) => session.id === activeSessionId) ??
        createChatSession();
      const updatedSession = {
        ...currentSession,
        id: activeSessionId,
        title: buildChatSessionTitle(messages),
        preview: buildChatSessionPreview(messages),
        messages,
        usage,
        lastRunSummary,
        selectedModelId,
        updatedAt: new Date().toISOString(),
      };

      return [
        updatedSession,
        ...previousSessions.filter((session) => session.id !== activeSessionId),
      ];
    });
  }, [activeSessionId, messages, usage, lastRunSummary, selectedModelId]);

  useEffect(() => {
    if (!composerDockRef.current || typeof ResizeObserver !== "function") {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const nextHeight = entries[0]?.contentRect?.height;
      if (typeof nextHeight === "number" && Number.isFinite(nextHeight)) {
        setComposerDockHeight(Math.ceil(nextHeight));
      }
    });

    observer.observe(composerDockRef.current);

    return () => {
      observer.disconnect();
    };
  }, [isEmptyState]);

  useEffect(() => {
    function hasFiles(event) {
      return Array.from(event.dataTransfer?.types ?? []).includes("Files");
    }

    function handleDragEnter(event) {
      if (!hasFiles(event)) {
        return;
      }

      event.preventDefault();
      dragCounterRef.current += 1;
      setIsDraggingFiles(true);
    }

    function handleDragOver(event) {
      if (!hasFiles(event)) {
        return;
      }

      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setIsDraggingFiles(true);
    }

    function handleDragLeave(event) {
      if (!hasFiles(event)) {
        return;
      }

      event.preventDefault();
      dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);

      if (dragCounterRef.current === 0) {
        setIsDraggingFiles(false);
      }
    }

    function handleDrop(event) {
      if (!hasFiles(event)) {
        return;
      }

      event.preventDefault();
      dragCounterRef.current = 0;
      setIsDraggingFiles(false);
      setIsAttachmentMenuOpen(false);

      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length > 0) {
        void addAttachments(files);
      }
    }

    window.addEventListener("dragenter", handleDragEnter);
    window.addEventListener("dragover", handleDragOver);
    window.addEventListener("dragleave", handleDragLeave);
    window.addEventListener("drop", handleDrop);

    return () => {
      window.removeEventListener("dragenter", handleDragEnter);
      window.removeEventListener("dragover", handleDragOver);
      window.removeEventListener("dragleave", handleDragLeave);
      window.removeEventListener("drop", handleDrop);
    };
  }, [pendingAttachments]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!chatContainerRef.current || !isRunning) {
      return;
    }

    const element = chatContainerRef.current;
    if (
      element.scrollHeight - element.scrollTop - element.clientHeight <
      STICKY_SCROLL_THRESHOLD
    ) {
      element.scrollTop = element.scrollHeight;
    }
  }, [messages, isRunning]);

  async function initializeApp() {
    setIsInitializing(true);
    setTopError(null);

    try {
      const [bootstrapData, meData] = await Promise.all([fetchBootstrap(), fetchMe()]);

      setBootstrap(bootstrapData);
      setSystemPrompt(DEFAULT_SYSTEM_PROMPT);

      if (meData.authenticated) {
        setAuthUser({ username: meData.username });
      } else {
        setAuthEnabled(meData.messagesLimit != null);
        setGuestMessagesUsed(meData.messagesUsed || 0);
        setGuestMessagesLimit(meData.messagesLimit ?? 5);
      }

      void loadUsage({ bootstrapData, silent: true });

      const problem = createBootstrapProblem(bootstrapData);
      if (problem) {
        setModels([]);
        setSelectedModelId(bootstrapData.defaults.model || "");
        setTopError(problem);
        return;
      }

      await loadModels(bootstrapData.defaults.model);
    } catch (error) {
      setTopError({
        title: "Startup failed",
        message: error.message,
      });
    } finally {
      setIsInitializing(false);
    }
  }

  async function handleLogin(username, password) {
    const data = await login(username, password);
    setAuthUser({ username: data.username });
    setGuestMessagesUsed(0);
    setShowLoginModal(false);
    setLoginLimitReached(false);
    setTopError(null);
  }

  async function handleLogout() {
    try {
      await logout();
    } catch {
      // ignore
    }
    setAuthUser(null);
    const meData = await fetchMe();
    setGuestMessagesUsed(meData.messagesUsed || 0);
    setGuestMessagesLimit(meData.messagesLimit ?? 5);
  }

  async function loadModels(preferredModelId = selectedModelId) {
    setIsRefreshingModels(true);

    try {
      const payload = await fetchModels();
      const nextModels = Array.isArray(payload.models) ? payload.models : [];
      setModels(nextModels);
      setSelectedModelId(pickInitialModel(nextModels, preferredModelId));

      if (nextModels.length === 0) {
        const providerErrors = Array.isArray(payload.providerErrors)
          ? payload.providerErrors
          : [];
        setTopError({
          title: "No models returned",
          message:
            providerErrors.length > 0
              ? providerErrors.map((error) => error.message).join("\n")
              : "No configured provider returned any models for this account.",
        });
      } else {
        setTopError(null);
      }
    } catch (error) {
      setTopError({
        title: "Model refresh failed",
        message: error.payload?.message || error.message,
      });
    } finally {
      setIsRefreshingModels(false);
    }
  }

  async function loadUsage({ bootstrapData = bootstrap, silent = false } = {}) {
    if (!silent) {
      setIsRefreshingUsage(true);
    }

    try {
      const payload = await fetchUsage();
      setUsageDashboard(payload);
    } catch (error) {
      setUsageDashboard(buildUsageFetchFailure(bootstrapData, error));
    } finally {
      setIsRefreshingUsage(false);
    }
  }

  function resizeInput() {
    if (!textareaRef.current) {
      return;
    }

    const target = textareaRef.current;
    target.style.height = "auto";
    const newHeight = Math.min(Math.max(target.scrollHeight, 48), 160);
    target.style.height = `${newHeight}px`;
  }

  function resetConversation() {
    requestAbortRef.current?.abort();
    const nextSession = createChatSession();
    setChatSessions((previousSessions) => [nextSession, ...previousSessions]);
    setActiveSessionId(nextSession.id);
    setMessages([]);
    setUsage(null);
    setLastRunSummary(null);
    setIsRunning(false);
    setPendingAttachments([]);
    setIsAttachmentMenuOpen(false);
    setInput("");
    setTopError(null);
    setShowHistorySidebar(false);
  }

  function onInterrupt() {
    requestAbortRef.current?.abort();
  }

  function openSettingsModal() {
    setShowHistorySidebar(false);
    setIsAttachmentMenuOpen(false);
    setShowConfigDrawer(true);
  }

  function openModelSettings() {
    setShowHistorySidebar(false);
    setIsAttachmentMenuOpen(false);
    setShowConfigDrawer(true);
    setIsModelPickerOpen(true);
  }

  function onSelectModel(modelId) {
    setSelectedModelId(modelId);
    setIsModelPickerOpen(false);
    setModelSearchQuery("");
  }

  function toggleHistorySidebar() {
    setIsAttachmentMenuOpen(false);
    setShowHistorySidebar((current) => !current);
  }

  function openChatSession(sessionId) {
    requestAbortRef.current?.abort();

    const targetSession = chatSessions.find((session) => session.id === sessionId);
    if (!targetSession) {
      return;
    }

    setActiveSessionId(targetSession.id);
    setMessages(targetSession.messages ?? []);
    setUsage(targetSession.usage ?? null);
    setLastRunSummary(targetSession.lastRunSummary ?? null);
    setSelectedModelId(targetSession.selectedModelId || selectedModelId);
    setPendingAttachments([]);
    setIsAttachmentMenuOpen(false);
    setInput("");
    setTopError(null);
    setIsRunning(false);
    setShowHistorySidebar(false);
  }

  async function createPendingAttachment(file) {
    const kind = detectAttachmentKind(file);

    if (!kind) {
      throw new Error("Only images, audio files, text files, and PDFs are supported.");
    }

    if (kind === "text") {
      if (file.size > MAX_TEXT_ATTACHMENT_BYTES) {
        throw new Error(
          `Text files must be ${formatBytes(MAX_TEXT_ATTACHMENT_BYTES)} or smaller.`
        );
      }

      const textContent = await file.text();
      return {
        id: createAttachmentId(),
        type: "attachment",
        kind,
        transport: "text",
        name: file.name,
        mimeType: file.type || "text/plain",
        size: file.size,
        textContent,
      };
    }

    const base64 = await readFileAsBase64(file);
    return {
      id: createAttachmentId(),
      type: "attachment",
      kind,
      transport: "inline_data",
      name: file.name,
      mimeType:
        file.type ||
        (kind === "pdf"
          ? "application/pdf"
          : kind === "audio"
            ? "audio/wav"
            : "application/octet-stream"),
      size: file.size,
      data: base64,
    };
  }

  async function addAttachments(files) {
    if (!files.length) {
      return;
    }

    setIsProcessingAttachments(true);

    const nextAttachments = [];
    const problems = [];
    let projectedBytes = pendingAttachments.reduce(
      (sum, attachment) => sum + (attachment.size ?? 0),
      0
    );

    for (const file of files) {
      try {
        projectedBytes += file.size;

        if (projectedBytes > MAX_PENDING_ATTACHMENT_BYTES) {
          throw new Error(
            `Keep total attachments under ${formatBytes(
              MAX_PENDING_ATTACHMENT_BYTES
            )} per message.`
          );
        }

        nextAttachments.push(await createPendingAttachment(file));
      } catch (error) {
        projectedBytes -= file.size;
        problems.push(`${file.name}: ${error.message}`);
      }
    }

    if (nextAttachments.length > 0) {
      setPendingAttachments((current) => [...current, ...nextAttachments]);
      textareaRef.current?.focus();
    }

    if (problems.length > 0) {
      setTopError({
        title: "Some files could not be attached",
        message: problems.join("\n"),
      });
    }

    setIsProcessingAttachments(false);
  }

  function removePendingAttachment(attachmentId) {
    setPendingAttachments((current) =>
      current.filter((attachment) => attachment.id !== attachmentId)
    );
  }

  function triggerFilePicker(kind) {
    setIsAttachmentMenuOpen(false);

    const refs = {
      images: imageInputRef,
      audio: audioInputRef,
      text: textInputRef,
      pdf: pdfInputRef,
    };

    refs[kind]?.current?.click();
  }

  function onFileInputChange(event) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";

    if (files.length > 0) {
      void addAttachments(files);
    }
  }

  async function onEnter(messageText) {
    const trimmed = messageText.trim();
    if ((!trimmed && pendingAttachments.length === 0) || !chatEnabled || isRunning) {
      return;
    }

    if (sendBlockedByQuota) {
      const topQuotaItem = selectedQuotaState?.topItem;
      setTopError({
        title: "Selected model looks exhausted",
        message: topQuotaItem
          ? `${selectedModelId} appears exhausted based on the last quota check at ${formatCheckedAt(selectedQuotaState.checkedAt)}. ${topQuotaItem.displayName}${topQuotaItem.limitName ? ` (${topQuotaItem.limitName})` : ""} is at ${formatNumber(topQuotaItem.usage)} / ${formatNumber(topQuotaItem.limit)}. Refresh usage data or choose another model.`
          : `${selectedModelId} appears exhausted based on the last quota check at ${formatCheckedAt(selectedQuotaState?.checkedAt)}.`,
      });
      return;
    }

    const userParts = [];

    if (trimmed) {
      userParts.push({ type: "text", text: trimmed });
    }

    userParts.push(...pendingAttachments);

    const userMessage = createUserMessage(userParts);
    const placeholder = createAssistantPlaceholder();
    const displayMessages = [...messages, userMessage, placeholder];
    const apiMessages = [...messages, userMessage]
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map(toApiMessage);

    const startedAt = performance.now();
    const controller = new AbortController();
    requestAbortRef.current = controller;

    setMessages(displayMessages);
    setInput("");
    setPendingAttachments([]);
    setIsAttachmentMenuOpen(false);
    setUsage(null);
    setLastRunSummary(null);
    setIsRunning(true);
    setTopError(null);

    try {
      await streamChatResponse({
        provider: modelProvider(selectedModel),
        modelId: selectedModel?.apiModelId || selectedModelId,
        systemPrompt,
        messages: apiMessages,
        signal: controller.signal,
        onEvent: ({ name, payload }) => {
          switch (name) {
            case "delta":
              setMessages((previousMessages) => {
                const nextMessages = [...previousMessages];
                const assistantIndex = nextMessages.length - 1;
                const assistantMessage = nextMessages[assistantIndex];

                if (!assistantMessage || assistantMessage.role !== "assistant") {
                  return previousMessages;
                }

                nextMessages[assistantIndex] = {
                  ...assistantMessage,
                  pending: true,
                  parts: mergeParts(assistantMessage.parts, payload.parts),
                };
                return nextMessages;
              });
              break;

            case "usage":
              setUsage(payload);
              break;

            case "complete":
              setMessages((previousMessages) => {
                const nextMessages = [...previousMessages];
                const assistantIndex = nextMessages.length - 1;
                if (assistantIndex >= 0) {
                  nextMessages[assistantIndex] = {
                    ...payload.message,
                    pending: false,
                  };
                }
                return nextMessages;
              });
              setLastRunSummary({
                durationSeconds: (performance.now() - startedAt) / 1000,
              });
              if (!authUser && authEnabled) {
                setGuestMessagesUsed((prev) => prev + 1);
              }
              void loadUsage({ silent: true });
              break;

            case "error": {
              if (payload.httpCode === 499) {
                return;
              }

              if (payload.details?.limitReached) {
                setGuestMessagesUsed(payload.details.limit ?? guestMessagesLimit);
                setLoginLimitReached(true);
                setShowLoginModal(true);
              }

              const quotaError = isQuotaError(payload);

              if (quotaError) {
                void loadUsage({ silent: true });
              }

              if (!quotaError && !payload.details?.limitReached) {
                setTopError({
                  title: "Model request failed",
                  message: payload.message,
                });
              }

              setMessages((previousMessages) => {
                const nextMessages = [...previousMessages];
                const lastMessage = nextMessages.at(-1);

                if (lastMessage?.role === "assistant") {
                  if (assistantHasContent(lastMessage)) {
                    nextMessages[nextMessages.length - 1] = {
                      ...lastMessage,
                      pending: false,
                    };
                  } else {
                    nextMessages.pop();
                  }
                }

                nextMessages.push(buildNoticeMessage(payload, selectedModelId));
                return nextMessages;
              });
              break;
            }

            default:
              break;
          }
        },
      });
    } catch (error) {
      if (error.name === "AbortError") {
        setMessages((previousMessages) => {
          const nextMessages = [...previousMessages];
          const lastMessage = nextMessages.at(-1);

          if (lastMessage?.role === "assistant") {
            if (assistantHasContent(lastMessage)) {
              nextMessages[nextMessages.length - 1] = {
                ...lastMessage,
                pending: false,
              };
            } else {
              nextMessages.pop();
            }
          }

          return nextMessages;
        });
      } else {
        setTopError({
          title: "Streaming failed",
          message: error.payload?.message || error.message,
        });
      }
    } finally {
      requestAbortRef.current = null;
      setIsRunning(false);
    }
  }

  function renderTopError() {
    if (!topError) {
      return null;
    }

    return (
      <div className="fixed left-1/2 top-5 z-40 w-[min(92vw,720px)] -translate-x-1/2 rounded-2xl border border-red-500/30 bg-red-950/90 px-4 py-3 text-sm text-red-100 shadow-2xl backdrop-blur">
        <p className="font-semibold">{topError.title}</p>
        <p className="mt-1 whitespace-pre-wrap text-red-100/85">{topError.message}</p>
      </div>
    );
  }

  function renderRunStats() {
    if (!usage && !lastRunSummary) {
      return null;
    }

    return (
      <div className="mt-3 flex flex-wrap gap-1.5 text-[11px] text-zinc-400">
        {usage?.promptTokenCount != null && (
          <span className="rounded-full border border-white/10 bg-black/20 px-2.5 py-1">
            prompt {formatNumber(usage.promptTokenCount)}
          </span>
        )}
        {usage?.candidatesTokenCount != null && (
          <span className="rounded-full border border-white/10 bg-black/20 px-2.5 py-1">
            output {formatNumber(usage.candidatesTokenCount)}
          </span>
        )}
        {usage?.totalTokenCount != null && (
          <span className="rounded-full border border-white/10 bg-black/20 px-2.5 py-1">
            total {formatNumber(usage.totalTokenCount)}
          </span>
        )}
        {lastRunSummary && (
          <span className="rounded-full border border-white/10 bg-black/20 px-2.5 py-1">
            {lastRunSummary.durationSeconds.toFixed(2)}s
          </span>
        )}
      </div>
    );
  }

  function renderQuotaBanner() {
    if (
      !selectedQuotaState ||
      !selectedQuotaState.topItem ||
      (!selectedQuotaState.exhausted && !selectedQuotaState.nearLimit)
    ) {
      return null;
    }

    const topQuotaItem = selectedQuotaState.topItem;
    const toneClasses = selectedQuotaState.exhausted
      ? "border-red-500/30 bg-red-500/10 text-red-100"
      : selectedQuotaState.nearLimit
        ? "border-amber-500/30 bg-amber-500/10 text-amber-100"
        : "border-white/10 bg-white/[0.03] text-zinc-300";
    const title = selectedQuotaState.exhausted
      ? "Selected model looks exhausted"
      : "Selected model is near its current quota";

    return (
      <div className={`mt-4 rounded-2xl border px-4 py-3 text-sm ${toneClasses}`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-semibold">{title}</p>
            <p className="mt-1 whitespace-pre-wrap">
              {topQuotaItem.displayName}
              {topQuotaItem.limitName ? ` (${topQuotaItem.limitName})` : ""}
              {`: ${formatNumber(topQuotaItem.usage)} / ${formatNumber(topQuotaItem.limit)} used`}
              {topQuotaItem.remaining != null
                ? `, ${formatNumber(topQuotaItem.remaining)} remaining. `
                : ". "}
              Checked {formatCheckedAt(selectedQuotaState.checkedAt)}.
            </p>
          </div>
          <button
            className="rounded-xl border border-white/10 bg-black/20 px-3 py-1.5 text-xs text-current hover:bg-black/30"
            onClick={() => loadUsage()}
            disabled={isRefreshingUsage}
          >
            {isRefreshingUsage ? "Refreshing..." : "Refresh usage"}
          </button>
        </div>
      </div>
    );
  }

  function renderComposerCard() {
    return (
      <div className="relative rounded-[28px] border border-white/10 bg-[#232323] px-4 pb-3 pt-3 shadow-[0_24px_80px_rgba(0,0,0,0.45)] sm:px-5">
        {ATTACHMENT_PICKERS.map((picker) => {
          const inputRefs = {
            images: imageInputRef,
            audio: audioInputRef,
            text: textInputRef,
            pdf: pdfInputRef,
          };

          return (
            <input
              key={picker.id}
              ref={inputRefs[picker.id]}
              type="file"
              className="hidden"
              accept={picker.accept}
              multiple
              onChange={onFileInputChange}
            />
          );
        })}

        <textarea
          ref={textareaRef}
          className="scrollbar-thin min-h-[48px] w-full resize-none bg-transparent py-1 text-base text-zinc-100 outline-none placeholder:text-zinc-500 disabled:cursor-not-allowed disabled:text-zinc-500"
          placeholder={
            pendingAttachments.length > 0
              ? "Ask something about the attached files..."
              : sendEnabled
              ? "Type a message..."
              : sendBlockedByQuota
                ? "This model appears exhausted from the last quota check."
                : bootstrapProblem
                  ? "Fix the local config or provider connection first."
                : "Select a chat-capable model to begin."
          }
          rows={1}
          value={input}
          disabled={!sendEnabled || isInitializing || isProcessingAttachments}
          onKeyDown={(event) => {
            if (
              canSendMessage &&
              !isRunning &&
              sendEnabled &&
              event.key === "Enter" &&
              !event.shiftKey
            ) {
              event.preventDefault();
              onEnter(input);
            }
          }}
          onInput={(event) => setInput(event.target.value)}
        />

        {pendingAttachments.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {pendingAttachments.map((attachment) => (
              <div
                key={attachment.id}
                className="flex max-w-full items-center gap-2 rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-zinc-200"
              >
                <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] text-zinc-400">
                  {attachmentKindLabel(attachment.kind)}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm">{attachment.name}</p>
                  <p className="text-xs text-zinc-500">{formatBytes(attachment.size)}</p>
                </div>
                <button
                  type="button"
                  className="rounded-full p-1 text-zinc-500 transition hover:bg-white/10 hover:text-zinc-200"
                  onClick={() => removePendingAttachment(attachment.id)}
                  aria-label={`Remove ${attachment.name}`}
                >
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
                </button>
              </div>
            ))}
          </div>
        )}

        {renderRunStats()}

        <div className="mt-3 border-t border-white/10" />

        {authEnabled && !authUser && (
          <div className="mt-2 flex items-center justify-between px-0.5">
            <span className="text-xs text-zinc-500">
              {Math.max(0, guestMessagesLimit - guestMessagesUsed)} guest message
              {guestMessagesLimit - guestMessagesUsed !== 1 ? "s" : ""} remaining
            </span>
            <button
              className="text-xs text-zinc-400 transition hover:text-zinc-200"
              onClick={() => { setLoginLimitReached(false); setShowLoginModal(true); }}
            >
              Sign in for unlimited →
            </button>
          </div>
        )}

        <div className="mt-2 flex items-center gap-2">
          <div className="relative" ref={attachmentMenuRef}>
            <button
              type="button"
              className="flex h-9 w-9 items-center justify-center rounded-full bg-white/5 text-xl text-zinc-300 transition hover:bg-white/10 disabled:opacity-50"
              onClick={() => setIsAttachmentMenuOpen((current) => !current)}
              disabled={isProcessingAttachments}
              aria-label="Attach files"
              title="Attach files"
            >
              +
            </button>

            {isAttachmentMenuOpen && (
              <div className="absolute bottom-[calc(100%+12px)] left-0 z-20 w-52 rounded-2xl border border-white/10 bg-[#191919] p-2 shadow-2xl">
                {ATTACHMENT_PICKERS.map((picker) => (
                  <button
                    key={picker.id}
                    type="button"
                    className="flex w-full items-center rounded-xl px-3 py-2.5 text-left text-sm text-zinc-200 transition hover:bg-white/5"
                    onClick={() => triggerFilePicker(picker.id)}
                  >
                    {picker.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="ml-auto flex min-w-0 items-center gap-2">
            <button
              className="max-w-[50vw] rounded-full border border-white/10 bg-white/5 px-3.5 py-1.5 text-sm text-zinc-200 transition hover:bg-white/10 disabled:opacity-50"
              onClick={openModelSettings}
              disabled={isRefreshingModels}
            >
              {modelChipLabel(selectedModel)}
            </button>

            {isRunning ? (
              <button
                className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-200 text-zinc-950 transition hover:bg-white"
                onClick={onInterrupt}
              >
                <StopIcon className="h-4.5 w-4.5" />
              </button>
            ) : (
              <button
                className={`flex h-9 w-9 items-center justify-center rounded-full transition ${
                  canSendMessage
                    ? "bg-zinc-200 text-zinc-950 hover:bg-white"
                    : "bg-white/10 text-zinc-500"
                }`}
                onClick={() => onEnter(input)}
                disabled={!canSendMessage}
              >
                <ArrowUpIcon className="h-4.5 w-4.5" />
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (isInitializing) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#111111] px-6 text-zinc-100">
        <div className="w-full max-w-[560px] rounded-[30px] border border-white/10 bg-[#1a1a1a] px-8 py-10 text-center shadow-2xl">
          <div className="mx-auto mb-6 h-14 w-14 rounded-2xl border border-white/10 bg-white/5" />
          <h1 className="text-3xl font-semibold tracking-tight">Loading models</h1>
          <p className="mt-3 text-sm text-zinc-400">
            Loading your local runtime config and available models.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#111111] text-zinc-100">
      {renderTopError()}

      {isDraggingFiles && (
        <div className="pointer-events-none fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="flex flex-col items-center justify-center rounded-[28px] border-2 border-dashed border-white/15 bg-[#151515] px-12 py-14 text-center shadow-2xl">
            <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-white/5 text-zinc-300">
              <ArrowUpIcon className="h-7 w-7" />
            </div>
            <p className="text-2xl font-semibold text-zinc-100">Attach a file</p>
            <p className="mt-2 text-sm text-zinc-400">Drop your files here to upload</p>
          </div>
        </div>
      )}

      <header className="fixed inset-x-0 top-0 z-40 px-4 pt-4 sm:px-6">
        <div className="mx-auto flex w-full max-w-[1280px] items-center justify-between">
          <button
            className="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-[#1d1d1d]/90 text-zinc-300 shadow-[0_12px_32px_rgba(0,0,0,0.28)] backdrop-blur transition hover:bg-[#252525]"
            onClick={toggleHistorySidebar}
            aria-label={showHistorySidebar ? "Hide chat history" : "Show chat history"}
            title={showHistorySidebar ? "Hide chat history" : "Show chat history"}
          >
            <SidebarIcon className="h-4 w-4" />
          </button>

          {selectedModel?.displayName && (
            <button
              className="hidden text-sm text-zinc-500 transition hover:text-zinc-300 sm:block"
              onClick={openModelSettings}
              title="Change model"
            >
              {selectedModel.displayName}
            </button>
          )}

          <div className="flex items-center gap-2">
            {authEnabled && (
              authUser ? (
                <div className="flex items-center gap-2 rounded-full border border-white/10 bg-[#1d1d1d]/90 px-3 py-1.5 shadow-[0_12px_32px_rgba(0,0,0,0.28)] backdrop-blur">
                  <span className="text-xs text-zinc-400">{authUser.username}</span>
                  <button
                    className="text-xs text-zinc-500 transition hover:text-zinc-300"
                    onClick={handleLogout}
                    title="Sign out"
                  >
                    Sign out
                  </button>
                </div>
              ) : (
                <button
                  className="rounded-full border border-white/10 bg-[#1d1d1d]/90 px-3 py-1.5 text-xs text-zinc-300 shadow-[0_12px_32px_rgba(0,0,0,0.28)] backdrop-blur transition hover:bg-[#252525]"
                  onClick={() => { setLoginLimitReached(false); setShowLoginModal(true); }}
                >
                  Sign in
                </button>
              )
            )}
            <button
              className="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-[#1d1d1d]/90 text-zinc-300 shadow-[0_12px_32px_rgba(0,0,0,0.28)] backdrop-blur transition hover:bg-[#252525]"
              onClick={openSettingsModal}
              aria-label="Open settings"
              title="Open settings"
            >
              <GearIcon className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>

      {showHistorySidebar && (
        <button
          className="fixed inset-0 z-20 bg-black/30 backdrop-blur-[1px]"
          onClick={() => setShowHistorySidebar(false)}
          aria-label="Close chat history"
        />
      )}

      <aside
        aria-hidden={!showHistorySidebar}
        className={`fixed inset-y-0 left-0 z-30 flex w-[300px] max-w-[86vw] flex-col border-r border-white/10 bg-[#171717]/96 px-4 pb-5 pt-24 shadow-2xl backdrop-blur-xl transition-[transform,visibility] duration-200 ${
          showHistorySidebar
            ? "translate-x-0"
            : "pointer-events-none invisible -translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.24em] text-zinc-500">Chats</p>
            <p className="mt-1 text-sm text-zinc-400">Local session history</p>
          </div>
          <button
            className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-zinc-300 transition hover:bg-white/10"
            onClick={resetConversation}
          >
            New chat
          </button>
        </div>

        <div className="scrollbar-dark mt-5 flex-1 overflow-y-auto pr-1">
          <div className="space-y-2">
            {chatSessions.map((session) => {
              const isActive = session.id === activeSessionId;

              return (
                <button
                  key={session.id}
                  type="button"
                  className={`w-full rounded-2xl border px-3 py-3 text-left transition ${
                    isActive
                      ? "border-white/15 bg-white/[0.08]"
                      : "border-transparent bg-transparent hover:border-white/10 hover:bg-white/[0.04]"
                  }`}
                  onClick={() => openChatSession(session.id)}
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="line-clamp-2 text-sm font-medium text-zinc-100">
                      {session.title}
                    </p>
                    <span className="shrink-0 pt-0.5 text-[11px] text-zinc-500">
                      {formatSessionTime(session.updatedAt)}
                    </span>
                  </div>
                  <p className="mt-2 line-clamp-2 text-xs leading-5 text-zinc-500">
                    {session.preview}
                  </p>
                </button>
              );
            })}
          </div>
        </div>
      </aside>

      {showConfigDrawer && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm sm:p-6"
          onClick={() => setShowConfigDrawer(false)}
        >
          <aside
            className="scrollbar-dark h-[min(88vh,980px)] w-[min(96vw,860px)] overflow-y-auto rounded-[32px] border border-white/10 bg-[#171717] px-5 py-6 shadow-2xl sm:px-6"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.28em] text-zinc-500">
                  Settings
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-zinc-300"
                  title={connectionStatus.title}
                >
                  <span
                    className={`h-2 w-2 rounded-full ${
                      connectionStatus.canConnect ? "bg-emerald-400" : "bg-red-400"
                    }`}
                  />
                  {connectionStatus.label}
                </span>
                <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-zinc-300">
                  {models.length} models
                </span>
                <button
                  className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-300 hover:bg-white/10"
                  onClick={() => setShowConfigDrawer(false)}
                >
                  Close
                </button>
              </div>
            </div>

            <section className="rounded-3xl border border-white/10 bg-white/[0.03] p-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium text-zinc-200">Model</h3>
                <button
                  className="rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-zinc-300 hover:bg-white/10 disabled:opacity-50"
                  onClick={() => loadModels(selectedModelId)}
                  disabled={isRefreshingModels || isRunning || bootstrapProblem}
                >
                  {isRefreshingModels ? "Refreshing..." : "Refresh"}
                </button>
              </div>

              {selectedModel && (
                <button
                  type="button"
                  className="mt-4 w-full rounded-2xl border border-white/10 bg-[#202020] p-4 text-left transition hover:bg-[#242424]"
                  onClick={() => setIsModelPickerOpen((current) => !current)}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">
                        Selected model
                      </p>
                      <p className="mt-2 truncate text-lg font-medium text-zinc-100">
                        {selectedModel.displayName}
                      </p>
                      <p className="mt-1 truncate text-sm text-zinc-500">
                        {modelProviderLabel(selectedModel)} / {selectedModel.id}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span
                        className={`rounded-full px-2.5 py-1 text-[11px] ${
                          selectedModel.enabledForChat
                            ? "bg-emerald-500/15 text-emerald-300"
                            : "bg-amber-500/15 text-amber-300"
                        }`}
                      >
                        {selectedModel.enabledForChat ? "Chat" : "Inspect"}
                      </span>
                      <ArrowRightIcon
                        className={`h-4 w-4 text-zinc-500 transition ${
                          isModelPickerOpen ? "rotate-90" : "-rotate-90"
                        }`}
                      />
                    </div>
                  </div>
                  <div className="mt-4 grid gap-2 text-xs text-zinc-400 sm:grid-cols-2">
                    <div className="rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2">
                      Input token limit: {formatNumber(selectedModel.inputTokenLimit)}
                    </div>
                    <div className="rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2">
                      Output token limit: {formatNumber(selectedModel.outputTokenLimit)}
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {selectedModel.supportedGenerationMethods.slice(0, 4).map((method) => (
                      <span
                        key={method}
                        className={`rounded-full px-2.5 py-1 text-xs ${
                          method === "generateContent" || method === "chat.completions"
                            ? "bg-emerald-500/15 text-emerald-300"
                            : "bg-white/5 text-zinc-400"
                        }`}
                      >
                        {method}
                      </span>
                    ))}
                    {selectedModel.supportedGenerationMethods.length > 4 && (
                      <span className="rounded-full bg-white/5 px-2.5 py-1 text-xs text-zinc-500">
                        +{selectedModel.supportedGenerationMethods.length - 4} more
                      </span>
                    )}
                  </div>
                </button>
              )}

              {isModelPickerOpen && (
                <>
                  <input
                    className="mt-4 w-full rounded-2xl border border-white/10 bg-[#222222] px-4 py-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
                    value={modelSearchQuery}
                    onChange={(event) => setModelSearchQuery(event.target.value)}
                    placeholder={`Search ${models.length} models by name, id, or capability`}
                    disabled={Boolean(bootstrapProblem) || isRefreshingModels}
                  />

                  <div className="mt-3 flex items-center justify-between text-xs text-zinc-500">
                    <span>
                      {filteredModels.length} match{filteredModels.length === 1 ? "" : "es"}
                    </span>
                    <span>
                      {models.filter((model) => model.enabledForChat).length} chat-capable
                    </span>
                  </div>

                  <div className="scrollbar-dark mt-3 max-h-[280px] overflow-y-auto rounded-2xl border border-white/10 bg-[#202020] p-2">
                    {filteredModels.length === 0 ? (
                      <div className="rounded-2xl border border-dashed border-white/10 px-4 py-5 text-sm text-zinc-500">
                        No models match that search.
                      </div>
                    ) : (
                      <div className="space-y-4">
                        {filteredModelGroups.map((group) => (
                          <div key={group.provider}>
                            <p className="px-2 pb-2 text-[11px] font-medium uppercase tracking-[0.22em] text-zinc-500">
                              {modelGroupLabel(group)}
                            </p>
                            <div className="space-y-2">
                              {group.models.map((model) => {
                                const isSelected = model.id === selectedModelId;

                                return (
                                  <button
                                    key={`${modelProvider(model)}-${model.id}`}
                                    type="button"
                                    className={`w-full rounded-2xl border px-3 py-3 text-left transition ${
                                      isSelected
                                        ? "border-emerald-400/60 bg-emerald-500/10"
                                        : "border-white/10 bg-white/[0.02] hover:bg-white/[0.05]"
                                    }`}
                                    onClick={() => onSelectModel(model.id)}
                                    disabled={Boolean(bootstrapProblem) || isRefreshingModels}
                                  >
                                    <div className="flex items-start justify-between gap-3">
                                      <div className="min-w-0">
                                        <p className="truncate text-sm font-medium text-zinc-100">
                                          {model.displayName}
                                        </p>
                                        <p className="mt-1 truncate text-xs text-zinc-500">
                                          {model.id}
                                        </p>
                                      </div>
                                      <span
                                        className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] ${
                                          model.enabledForChat
                                            ? "bg-emerald-500/15 text-emerald-300"
                                            : "bg-amber-500/15 text-amber-300"
                                        }`}
                                      >
                                        {model.enabledForChat ? "Chat" : "Inspect only"}
                                      </span>
                                    </div>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}

              {selectedModel && !selectedModel.enabledForChat && (
                <div className="mt-3 rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                  This model is visible for inspection, but this UI only sends chat requests to
                  chat-capable provider endpoints.
                </div>
              )}
            </section>

            <section className="mt-4 rounded-3xl border border-white/10 bg-white/[0.03] p-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium text-zinc-200">System prompt</h3>
                <button
                  className="rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-zinc-300 hover:bg-white/10"
                  onClick={() => setSystemPrompt(DEFAULT_SYSTEM_PROMPT)}
                >
                  Reset
                </button>
              </div>
              <textarea
                value={systemPrompt}
                onChange={(event) => setSystemPrompt(event.target.value)}
                className="mt-4 min-h-[180px] w-full resize-none rounded-2xl border border-white/10 bg-[#222222] px-4 py-3 text-sm text-zinc-200 outline-none"
              />
            </section>

            <UsagePanel
              usageDashboard={usageDashboard}
              isRefreshingUsage={isRefreshingUsage}
              onRefresh={() => loadUsage()}
              selectedModelId={selectedModelId}
            />

            {messages.length > 0 && (
              <section className="mt-4 rounded-3xl border border-white/10 bg-white/[0.03] p-4 text-sm text-zinc-400">
                <button
                  className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-zinc-300 hover:bg-white/10"
                  onClick={resetConversation}
                >
                  Reset conversation
                </button>
              </section>
            )}
          </aside>
        </div>
      )}

      <main className="flex min-h-screen flex-col">
        {isEmptyState ? (
          <div className="flex flex-1 items-center justify-center px-4 pb-10 pt-24 sm:px-6">
            <div className="w-full max-w-[860px]">
              <div className="mx-auto max-w-[720px] text-center">
                <p className="text-4xl font-semibold tracking-tight text-zinc-50 sm:text-5xl">
                  {selectedModel?.displayName || "Choose a model"}
                </p>
                <p className="mt-3 text-lg text-zinc-400">
                  Type a message or upload files to get started.
                </p>
                {bootstrapProblem && (
                  <p className="mx-auto mt-4 max-w-[720px] text-sm text-red-300">
                    {bootstrapProblem.message}
                  </p>
                )}
              </div>

              <div ref={composerDockRef} className="mx-auto mt-10 w-full max-w-[720px]">
                {renderComposerCard()}
                {renderQuotaBanner()}
              </div>
            </div>
          </div>
        ) : (
          <>
            <div
              ref={chatContainerRef}
              className="scrollbar-dark flex-1 overflow-y-auto px-4 pt-24 sm:px-6"
              style={{ paddingBottom: `${composerDockHeight + 28}px` }}
            >
              <div className="mx-auto w-full max-w-[920px]">
                <Chat messages={messages} />
              </div>
            </div>

            <div
              ref={composerDockRef}
              className="fixed inset-x-0 bottom-0 z-10 px-4 pb-6 sm:px-6 sm:pb-8"
            >
              <div className="mx-auto w-full max-w-[860px]">
                {renderComposerCard()}
                {renderQuotaBanner()}
              </div>
            </div>
          </>
        )}
      </main>
      {showLoginModal && (
        <LoginModal
          onLogin={handleLogin}
          onClose={() => { if (!loginLimitReached) setShowLoginModal(false); }}
          limitReached={loginLimitReached}
          messagesLimit={guestMessagesLimit}
        />
      )}
    </div>
  );
}

export default App;
