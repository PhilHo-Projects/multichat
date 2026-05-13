import { GoogleAuth } from "google-auth-library";

import { AppError } from "./config.js";

const CLOUD_PLATFORM_READ_ONLY_SCOPE =
  "https://www.googleapis.com/auth/cloud-platform.read-only";
const MONITORING_API_BASE = "https://monitoring.googleapis.com/v3";
const NEAR_LIMIT_THRESHOLD = 0.85;
const QUERY_CONCURRENCY = 6;
const FALLBACK_QUOTA_BASES = [
  "generate_content_free_tier_requests",
  "generate_content_free_tier_input_token_count",
  "generate_requests_per_model",
  "generate_content_paid_tier_input_token_count",
  "generate_content_paid_tier_2_requests",
  "generate_content_paid_tier_2_input_token_count",
  "generate_content_paid_tier_3_requests",
  "generate_content_paid_tier_3_input_token_count",
];

const googleCloudAuth = new GoogleAuth({
  scopes: [CLOUD_PLATFORM_READ_ONLY_SCOPE],
});

export async function fetchQuotaDashboard({
  projectId,
  serviceName,
  lookbackHours,
}) {
  const checkedAt = new Date().toISOString();
  const setup = buildSetupData({ projectId, serviceName });

  if (!projectId) {
    return buildFailureResponse({
      projectId,
      serviceName,
      lookbackHours,
      checkedAt,
      setup,
      error: new AppError(
        "Quota lookup is not configured yet because GOOGLE_CLOUD_PROJECT_ID is missing.",
        { httpCode: 503 }
      ),
      fallbackCode: "missing_project_id",
    });
  }

  let authInfo = buildUnknownAuthInfo();
  let client;

  try {
    ({ client, authInfo } = await createAuthorizedClient());
  } catch (error) {
    return buildFailureResponse({
      projectId,
      serviceName,
      lookbackHours,
      checkedAt,
      setup,
      error: error instanceof AppError ? error : normalizeGoogleCloudError(error),
      authInfo,
      fallbackCode: "auth_unavailable",
    });
  }

  try {
    const descriptors = await listQuotaMetricDescriptors({
      client,
      projectId,
      serviceName,
    });
    const quotaGroups = buildQuotaMetricGroups({ descriptors, serviceName });
    const seriesResults = await runWithConcurrency(
      quotaGroups,
      QUERY_CONCURRENCY,
      (group) =>
        fetchQuotaGroupSeries({
          client,
          projectId,
          group,
          lookbackHours,
        })
    );
    const items = buildQuotaItems(seriesResults);
    const modelSummaries = buildModelSummaries(items);

    return {
      status: "ok",
      projectId,
      service: serviceName,
      checkedAt,
      lookbackHours,
      auth: authInfo,
      summary: buildDashboardSummary(items, modelSummaries),
      items,
      modelSummaries,
      setup,
      error: null,
      notes: [
        "Quota data comes from Cloud Monitoring time series for the target Google Cloud project.",
        "Model-specific rows appear only when Google emits a model label for that quota metric.",
      ],
      assumptions: [
        "Usage compares the newest usage point against the newest limit point for the same project/model/limit key.",
        "Some quota families are project-wide even when model-specific metrics exist elsewhere in the service.",
      ],
    };
  } catch (error) {
    return buildFailureResponse({
      projectId,
      serviceName,
      lookbackHours,
      checkedAt,
      setup,
      error: error instanceof AppError ? error : normalizeGoogleCloudError(error),
      authInfo,
    });
  }
}

async function createAuthorizedClient() {
  let client;

  try {
    client = await googleCloudAuth.getClient();
  } catch (error) {
    throw normalizeGoogleCloudError(error);
  }

  let credentials = {};
  try {
    credentials = await googleCloudAuth.getCredentials();
  } catch {
    credentials = {};
  }

  return {
    client,
    authInfo: {
      method: "application_default_credentials",
      credentialType: inferCredentialType(client, credentials),
      principalEmail: credentials.client_email ?? null,
    },
  };
}

function buildUnknownAuthInfo() {
  return {
    method: "application_default_credentials",
    credentialType: null,
    principalEmail: null,
  };
}

function inferCredentialType(client, credentials) {
  if (credentials?.client_email) {
    return "service_account";
  }

  const clientName = client?.constructor?.name ?? "";
  switch (clientName) {
    case "UserRefreshClient":
      return "authorized_user";
    case "JWT":
      return "service_account";
    case "Compute":
      return "metadata_service";
    case "Impersonated":
    case "ImpersonatedCredentialsClient":
      return "impersonated";
    case "AwsClient":
    case "IdentityPoolClient":
    case "ExternalAccountClient":
      return "external_account";
    default:
      return clientName ? clientName.toLowerCase() : "unknown";
  }
}

async function listQuotaMetricDescriptors({ client, projectId, serviceName }) {
  const url = new URL(
    `${MONITORING_API_BASE}/projects/${encodeURIComponent(projectId)}/metricDescriptors`
  );
  url.searchParams.set(
    "filter",
    `metric.type = starts_with("${serviceName}/quota/")`
  );
  url.searchParams.set("pageSize", "200");

  return listAllPages({
    client,
    url,
    fieldName: "metricDescriptors",
  });
}

function buildQuotaMetricGroups({ descriptors, serviceName }) {
  const groups = new Map();
  const metricPattern = new RegExp(
    `^${escapeRegExp(serviceName)}/quota/(.+)/(usage|limit|exceeded)$`
  );

  for (const descriptor of descriptors) {
    const metricType = descriptor?.type ?? "";
    const match = metricType.match(metricPattern);
    if (!match) {
      continue;
    }

    const [, baseName, kind] = match;
    if (isInternalQuotaBase(baseName)) {
      continue;
    }

    const existingGroup = groups.get(baseName) ?? {
      baseName,
      quotaMetric: `${serviceName}/${baseName}`,
      displayName: prettifyQuotaBase(baseName),
      unit: descriptor?.unit ?? null,
      descriptors: {},
    };

    existingGroup.descriptors[kind] = descriptor;
    existingGroup.displayName = simplifyDescriptorDisplayName(
      descriptor?.displayName,
      existingGroup.displayName
    );
    existingGroup.unit = existingGroup.unit ?? descriptor?.unit ?? null;
    groups.set(baseName, existingGroup);
  }

  for (const baseName of FALLBACK_QUOTA_BASES) {
    if (groups.has(baseName) || isInternalQuotaBase(baseName)) {
      continue;
    }

    groups.set(baseName, {
      baseName,
      quotaMetric: `${serviceName}/${baseName}`,
      displayName: prettifyQuotaBase(baseName),
      unit: null,
      descriptors: {},
    });
  }

  return Array.from(groups.values()).sort((left, right) =>
    left.displayName.localeCompare(right.displayName)
  );
}

function isInternalQuotaBase(baseName) {
  return /_internal($|_)/.test(baseName);
}

function simplifyDescriptorDisplayName(displayName, fallbackDisplayName) {
  if (typeof displayName !== "string" || !displayName.trim()) {
    return fallbackDisplayName;
  }

  return displayName
    .replace(/\s+quota usage$/i, "")
    .replace(/\s+quota limit$/i, "")
    .replace(/\s+quota exceeded error$/i, "")
    .trim();
}

function prettifyQuotaBase(baseName) {
  return baseName
    .split("_")
    .filter(Boolean)
    .map((part, index) => {
      if (index === 0) {
        return part.charAt(0).toUpperCase() + part.slice(1);
      }

      return part;
    })
    .join(" ");
}

async function fetchQuotaGroupSeries({
  client,
  projectId,
  group,
  lookbackHours,
}) {
  const [limitSeries, usageSeries, exceededSeries] = await Promise.all([
    safeListTimeSeries({
      client,
      projectId,
      metricType: toMetricType(group, "limit"),
      lookbackHours,
    }),
    safeListTimeSeries({
      client,
      projectId,
      metricType: toMetricType(group, "usage"),
      lookbackHours,
    }),
    safeListTimeSeries({
      client,
      projectId,
      metricType: toMetricType(group, "exceeded"),
      lookbackHours,
    }),
  ]);

  return {
    group,
    limitSeries,
    usageSeries,
    exceededSeries,
  };
}

function toMetricType(group, kind) {
  return `${group.quotaMetric.replace(/\/([^/]+)$/, "/quota/$1")}/${kind}`;
}

async function safeListTimeSeries({ client, projectId, metricType, lookbackHours }) {
  try {
    return await listTimeSeries({
      client,
      projectId,
      metricType,
      lookbackHours,
    });
  } catch (error) {
    if (isMetricMissingError(error)) {
      return [];
    }

    throw error;
  }
}

function isMetricMissingError(error) {
  if (!(error instanceof AppError)) {
    return false;
  }

  if (error.httpCode !== 400 && error.httpCode !== 404) {
    return false;
  }

  return /metric descriptor|time series data|not found/i.test(error.message);
}

async function listTimeSeries({ client, projectId, metricType, lookbackHours }) {
  const endTime = new Date();
  const startTime = new Date(
    endTime.getTime() - Math.max(1, lookbackHours) * 60 * 60 * 1000
  );
  const url = new URL(
    `${MONITORING_API_BASE}/projects/${encodeURIComponent(projectId)}/timeSeries`
  );
  url.searchParams.set(
    "filter",
    `metric.type = "${metricType}" AND project = "${projectId}"`
  );
  url.searchParams.set("interval.startTime", startTime.toISOString());
  url.searchParams.set("interval.endTime", endTime.toISOString());
  url.searchParams.set("view", "FULL");
  url.searchParams.set("pageSize", "1000");

  return listAllPages({
    client,
    url,
    fieldName: "timeSeries",
  });
}

async function listAllPages({ client, url, fieldName }) {
  const items = [];
  let pageToken = "";

  do {
    const pagedUrl = new URL(url.toString());
    if (pageToken) {
      pagedUrl.searchParams.set("pageToken", pageToken);
    }

    const payload = await requestGoogleJson(client, pagedUrl.toString());
    if (Array.isArray(payload?.[fieldName])) {
      items.push(...payload[fieldName]);
    }

    pageToken = payload?.nextPageToken ?? "";
  } while (pageToken);

  return items;
}

async function requestGoogleJson(client, url) {
  try {
    const response = await client.request({
      url,
      method: "GET",
    });

    return response.data;
  } catch (error) {
    throw normalizeGoogleCloudError(error);
  }
}

function normalizeGoogleCloudError(error) {
  if (error instanceof AppError) {
    return error;
  }

  const status = error?.response?.status ?? error?.status ?? 500;
  const payload = error?.response?.data ?? null;
  const googleError = payload?.error ?? null;
  const message =
    googleError?.message ??
    payload?.message ??
    error?.message ??
    "Google Cloud request failed.";

  return new AppError(message, {
    httpCode: status,
    googleStatus: googleError?.status ?? null,
    details: googleError?.details ?? payload?.details ?? payload,
  });
}

function buildQuotaItems(groupResults) {
  const items = [];

  for (const result of groupResults) {
    const groupedItems = new Map();

    mergeQuotaSeriesIntoItems(groupedItems, result.group, result.limitSeries, "limit");
    mergeQuotaSeriesIntoItems(groupedItems, result.group, result.usageSeries, "usage");
    mergeQuotaSeriesIntoItems(
      groupedItems,
      result.group,
      result.exceededSeries,
      "exceeded"
    );

    for (const entry of groupedItems.values()) {
      const usageValue = entry.usage ?? (entry.limit != null ? 0 : null);
      const limitValue = entry.limit ?? null;
      const remaining =
        usageValue != null && limitValue != null ? limitValue - usageValue : null;
      const usagePercent =
        usageValue != null && limitValue != null && limitValue > 0
          ? (usageValue / limitValue) * 100
          : null;
      const exceeded = Boolean(entry.exceededEvents > 0 || entry.exceededFlag);
      const exhausted = Boolean(
        exceeded ||
          (usageValue != null && limitValue != null && usageValue >= limitValue)
      );
      const nearLimit = Boolean(
        !exhausted &&
          usagePercent != null &&
          usagePercent >= NEAR_LIMIT_THRESHOLD * 100
      );

      if (usageValue == null && limitValue == null && !exceeded) {
        continue;
      }

      items.push({
        key: entry.key,
        quotaMetric: result.group.quotaMetric,
        metricBase: result.group.baseName,
        displayName: result.group.displayName,
        unit: result.group.unit,
        scope: entry.modelId ? "model" : "project",
        modelId: entry.modelId,
        modelLabel: entry.modelLabel,
        location: entry.location,
        limitName: entry.limitName,
        window: inferQuotaWindow({
          limitName: entry.limitName,
          baseName: result.group.baseName,
          displayName: result.group.displayName,
        }),
        usage: usageValue,
        limit: limitValue,
        remaining,
        usagePercent,
        exhausted,
        nearLimit,
        exceeded,
        exceededEvents: entry.exceededEvents,
        methods: Array.from(entry.methods).sort(),
        checkedAt:
          entry.latestTimestamp ??
          entry.limitCheckedAt ??
          entry.usageCheckedAt ??
          entry.exceededCheckedAt ??
          null,
        usageCheckedAt: entry.usageCheckedAt,
        limitCheckedAt: entry.limitCheckedAt,
        exceededCheckedAt: entry.exceededCheckedAt,
        raw: {
          extraMetricLabels: entry.extraMetricLabels,
          extraResourceLabels: entry.extraResourceLabels,
          usageMetricType: toMetricType(result.group, "usage"),
          limitMetricType: toMetricType(result.group, "limit"),
          exceededMetricType: toMetricType(result.group, "exceeded"),
        },
      });
    }
  }

  return items.sort(compareQuotaItems);
}

function mergeQuotaSeriesIntoItems(targetMap, group, seriesList, kind) {
  for (const series of seriesList) {
    const dimensions = extractSeriesDimensions(group, series);
    const entry = getOrCreateQuotaEntry(targetMap, group, dimensions);

    if (kind === "limit") {
      const latestPoint = getLatestPoint(series);
      const numericValue = toNumericValue(latestPoint?.value ?? null);
      if (numericValue != null) {
        entry.limit = numericValue;
        entry.limitCheckedAt = latestPoint?.timestamp ?? entry.limitCheckedAt;
        entry.latestTimestamp = pickLatestTimestamp(
          entry.latestTimestamp,
          latestPoint?.timestamp ?? null
        );
      }
      continue;
    }

    if (kind === "usage") {
      const latestPoint = getLatestPoint(series);
      const numericValue = toNumericValue(latestPoint?.value ?? null);
      if (numericValue != null) {
        entry.usage = (entry.usage ?? 0) + numericValue;
        entry.usageCheckedAt = latestPoint?.timestamp ?? entry.usageCheckedAt;
        entry.latestTimestamp = pickLatestTimestamp(
          entry.latestTimestamp,
          latestPoint?.timestamp ?? null
        );
      }

      if (dimensions.method) {
        entry.methods.add(dimensions.method);
      }
      continue;
    }

    const exceededSummary = summarizeExceededSeries(series);
    entry.exceededEvents += exceededSummary.count;
    entry.exceededFlag = entry.exceededFlag || exceededSummary.count > 0;
    entry.exceededCheckedAt = pickLatestTimestamp(
      entry.exceededCheckedAt,
      exceededSummary.timestamp
    );
    entry.latestTimestamp = pickLatestTimestamp(
      entry.latestTimestamp,
      exceededSummary.timestamp
    );
  }
}

function extractSeriesDimensions(group, series) {
  const metricLabels = series?.metric?.labels ?? {};
  const resourceLabels = series?.resource?.labels ?? {};

  return {
    modelId: normalizeMonitoredModel(metricLabels.model ?? null),
    modelLabel: metricLabels.model ?? null,
    limitName: metricLabels.limit_name ?? null,
    location: resourceLabels.location ?? null,
    method: metricLabels.method ?? null,
    extraMetricLabels: objectWithoutKeys(metricLabels, [
      "model",
      "limit_name",
      "method",
    ]),
    extraResourceLabels: objectWithoutKeys(resourceLabels, [
      "location",
      "resource_container",
    ]),
    resourceType: series?.resource?.type ?? null,
    group,
  };
}

function getOrCreateQuotaEntry(targetMap, group, dimensions) {
  const key = createQuotaEntryKey(group.baseName, dimensions);
  if (!targetMap.has(key)) {
    targetMap.set(key, {
      key,
      modelId: dimensions.modelId,
      modelLabel: dimensions.modelLabel,
      limitName: dimensions.limitName,
      location: dimensions.location,
      extraMetricLabels: dimensions.extraMetricLabels,
      extraResourceLabels: dimensions.extraResourceLabels,
      limit: null,
      usage: null,
      exceededEvents: 0,
      exceededFlag: false,
      methods: new Set(),
      latestTimestamp: null,
      usageCheckedAt: null,
      limitCheckedAt: null,
      exceededCheckedAt: null,
    });
  }

  return targetMap.get(key);
}

function createQuotaEntryKey(baseName, dimensions) {
  return JSON.stringify({
    baseName,
    modelId: dimensions.modelId ?? null,
    limitName: dimensions.limitName ?? null,
    location: dimensions.location ?? null,
    extraMetricLabels: dimensions.extraMetricLabels,
    extraResourceLabels: dimensions.extraResourceLabels,
  });
}

function objectWithoutKeys(source, excludedKeys) {
  return Object.fromEntries(
    Object.entries(source)
      .filter(([key, value]) => !excludedKeys.includes(key) && value != null)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
  );
}

function normalizeMonitoredModel(modelLabel) {
  if (typeof modelLabel !== "string" || !modelLabel.trim()) {
    return null;
  }

  return modelLabel.replace(/^models\//, "").trim() || null;
}

function getLatestPoint(series) {
  const points = Array.isArray(series?.points) ? [...series.points] : [];
  if (points.length === 0) {
    return null;
  }

  points.sort((left, right) => {
    const leftTime = Date.parse(
      left?.interval?.endTime ?? left?.interval?.startTime ?? 0
    );
    const rightTime = Date.parse(
      right?.interval?.endTime ?? right?.interval?.startTime ?? 0
    );

    return rightTime - leftTime;
  });

  const point = points[0];
  return {
    value: point?.value ?? null,
    timestamp: point?.interval?.endTime ?? point?.interval?.startTime ?? null,
  };
}

function summarizeExceededSeries(series) {
  const points = Array.isArray(series?.points) ? series.points : [];
  let count = 0;
  let timestamp = null;

  for (const point of points) {
    const numericValue = toNumericValue(point?.value ?? null);
    if (numericValue != null) {
      count += numericValue;
    }

    timestamp = pickLatestTimestamp(
      timestamp,
      point?.interval?.endTime ?? point?.interval?.startTime ?? null
    );
  }

  return {
    count,
    timestamp,
  };
}

function toNumericValue(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  if (typeof value.int64Value === "string") {
    const parsedValue = Number(value.int64Value);
    return Number.isFinite(parsedValue) ? parsedValue : null;
  }

  if (typeof value.doubleValue === "number") {
    return Number.isFinite(value.doubleValue) ? value.doubleValue : null;
  }

  if (typeof value.boolValue === "boolean") {
    return value.boolValue ? 1 : 0;
  }

  return null;
}

function pickLatestTimestamp(leftTimestamp, rightTimestamp) {
  if (!leftTimestamp) {
    return rightTimestamp ?? null;
  }

  if (!rightTimestamp) {
    return leftTimestamp;
  }

  return Date.parse(rightTimestamp) > Date.parse(leftTimestamp)
    ? rightTimestamp
    : leftTimestamp;
}

function inferQuotaWindow({ limitName, baseName, displayName }) {
  const haystack = [limitName, displayName, baseName].filter(Boolean).join(" ").toLowerCase();

  if (/per day|daily|day\b/.test(haystack) || /_per_day/.test(baseName)) {
    return "day";
  }

  if (/per minute|minute|min\b/.test(haystack)) {
    return "minute";
  }

  if (/per hour|hour\b/.test(haystack)) {
    return "hour";
  }

  if (/concurrent|in[- ]use/.test(haystack)) {
    return "concurrent";
  }

  return null;
}

function compareQuotaItems(left, right) {
  const leftScore = itemSeverityScore(left);
  const rightScore = itemSeverityScore(right);

  if (leftScore !== rightScore) {
    return rightScore - leftScore;
  }

  const leftPercent = left.usagePercent ?? -1;
  const rightPercent = right.usagePercent ?? -1;
  if (leftPercent !== rightPercent) {
    return rightPercent - leftPercent;
  }

  return left.displayName.localeCompare(right.displayName);
}

function itemSeverityScore(item) {
  if (item.exhausted) {
    return 3;
  }

  if (item.nearLimit) {
    return 2;
  }

  if ((item.usage ?? 0) > 0) {
    return 1;
  }

  return 0;
}

function buildModelSummaries(items) {
  const summaries = new Map();

  for (const item of items) {
    if (!item.modelId) {
      continue;
    }

    if (!summaries.has(item.modelId)) {
      summaries.set(item.modelId, {
        modelId: item.modelId,
        exhausted: false,
        nearLimit: false,
        highestUsagePercent: null,
        blockingItems: [],
        totalItems: 0,
      });
    }

    const summary = summaries.get(item.modelId);
    summary.totalItems += 1;
    summary.exhausted = summary.exhausted || item.exhausted;
    summary.nearLimit = summary.nearLimit || item.nearLimit;
    summary.highestUsagePercent = Math.max(
      summary.highestUsagePercent ?? 0,
      item.usagePercent ?? 0
    );

    if (item.exhausted || item.nearLimit) {
      summary.blockingItems.push({
        key: item.key,
        displayName: item.displayName,
        limitName: item.limitName,
        usage: item.usage,
        limit: item.limit,
        remaining: item.remaining,
        usagePercent: item.usagePercent,
        exhausted: item.exhausted,
        nearLimit: item.nearLimit,
      });
    }
  }

  return Array.from(summaries.values()).sort((left, right) => {
    const leftScore = (left.exhausted ? 2 : 0) + (left.nearLimit ? 1 : 0);
    const rightScore = (right.exhausted ? 2 : 0) + (right.nearLimit ? 1 : 0);
    if (leftScore !== rightScore) {
      return rightScore - leftScore;
    }

    return (right.highestUsagePercent ?? 0) - (left.highestUsagePercent ?? 0);
  });
}

function buildDashboardSummary(items, modelSummaries) {
  const exhaustedCount = items.filter((item) => item.exhausted).length;
  const nearLimitCount = items.filter((item) => item.nearLimit).length;

  return {
    totalItems: items.length,
    exhaustedCount,
    nearLimitCount,
    modelCount: modelSummaries.length,
    projectWideCount: items.filter((item) => !item.modelId).length,
  };
}

function buildSetupData({ projectId, serviceName }) {
  return {
    projectIdConfigured: Boolean(projectId),
    projectId: projectId || null,
    service: serviceName,
    authMethod: "application_default_credentials",
    env: [
      "GOOGLE_CLOUD_PROJECT_ID",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "GOOGLE_CLOUD_QUOTA_LOOKBACK_HOURS",
    ],
    instructions: [
      projectId
        ? null
        : "Set GOOGLE_CLOUD_PROJECT_ID to the Google Cloud project behind your AI Studio usage page.",
      "Recommended setup: point GOOGLE_APPLICATION_CREDENTIALS at a service account JSON file on this machine.",
      "Grant the Cloud auth identity a Monitoring read role on the target project, such as roles/monitoring.viewer.",
      "Enable the Cloud Monitoring API for the target project if Google returns an API-disabled error.",
    ].filter(Boolean),
  };
}

function buildFailureResponse({
  projectId,
  serviceName,
  lookbackHours,
  checkedAt,
  setup,
  error,
  authInfo,
  fallbackCode = null,
}) {
  const classifiedError = classifyUsageError(error, fallbackCode);

  return {
    status: classifiedError.setupRequired ? "setup_required" : "error",
    projectId: projectId || null,
    service: serviceName,
    checkedAt,
    lookbackHours,
    auth: authInfo ?? buildUnknownAuthInfo(),
    summary: buildDashboardSummary([], []),
    items: [],
    modelSummaries: [],
    setup,
    error: {
      code: classifiedError.code,
      message: error.message,
      httpCode: error.httpCode ?? null,
      googleStatus: error.googleStatus ?? null,
      details: error.details ?? null,
    },
    notes: [
      "Chat remains available even when quota lookup is unavailable.",
      "Quota lookup requires Google Cloud Monitoring access for the target project.",
    ],
    assumptions: [],
  };
}

function classifyUsageError(error, fallbackCode = null) {
  const message = String(error?.message ?? "");
  const googleStatus = error?.googleStatus ?? null;
  const httpCode = error?.httpCode ?? null;

  if (fallbackCode === "missing_project_id") {
    return {
      code: "missing_project_id",
      setupRequired: true,
    };
  }

  if (/default credentials|application default credentials/i.test(message)) {
    return {
      code: "auth_unavailable",
      setupRequired: true,
    };
  }

  if (httpCode === 401 || googleStatus === "UNAUTHENTICATED") {
    return {
      code: "auth_invalid",
      setupRequired: true,
    };
  }

  if (httpCode === 403 || googleStatus === "PERMISSION_DENIED") {
    return {
      code: /api .* has not been used|disabled/i.test(message)
        ? "api_disabled"
        : "permission_denied",
      setupRequired: true,
    };
  }

  if (httpCode === 404) {
    return {
      code: "project_or_metric_not_found",
      setupRequired: true,
    };
  }

  if (/network|fetch|econn/i.test(message)) {
    return {
      code: "network_error",
      setupRequired: false,
    };
  }

  return {
    code: fallbackCode ?? "usage_fetch_failed",
    setupRequired: httpCode == null || httpCode >= 500,
  };
}

async function runWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let currentIndex = 0;

  async function runNext() {
    while (currentIndex < items.length) {
      const index = currentIndex;
      currentIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }

  const runners = Array.from(
    { length: Math.min(concurrency, Math.max(items.length, 1)) },
    () => runNext()
  );

  await Promise.all(runners);
  return results;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
