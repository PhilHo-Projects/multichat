/* eslint-disable react/prop-types */
function formatNumber(value) {
  if (typeof value !== "number") {
    return "n/a";
  }

  return new Intl.NumberFormat().format(value);
}

function formatPercent(value) {
  if (typeof value !== "number") {
    return "n/a";
  }

  return `${Math.round(value)}%`;
}

function formatCheckedAt(value) {
  if (!value) {
    return "n/a";
  }

  return new Date(value).toLocaleString();
}

function normalizeModelId(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.replace(/^models\//, "").trim().toLowerCase();
}

function matchesSelectedModel(item, selectedModelId) {
  if (!item?.modelId) {
    return true;
  }

  return normalizeModelId(item.modelId) === normalizeModelId(selectedModelId);
}

function rowToneClasses(item) {
  if (item.exhausted) {
    return "border-red-500/30 bg-red-500/10";
  }

  if (item.nearLimit) {
    return "border-amber-500/30 bg-amber-500/10";
  }

  return "border-white/10 bg-[#202020]";
}

function statusChip(item) {
  if (item.exhausted) {
    return "Exhausted";
  }

  if (item.nearLimit) {
    return "Near limit";
  }

  return "OK";
}

function statusChipClasses(item) {
  if (item.exhausted) {
    return "bg-red-500/15 text-red-200";
  }

  if (item.nearLimit) {
    return "bg-amber-500/15 text-amber-200";
  }

  return "bg-emerald-500/15 text-emerald-200";
}

function renderQuotaRows(items) {
  if (items.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-white/10 px-4 py-5 text-sm text-zinc-500">
        No matching quota series were returned for this project yet.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {items.map((item) => (
        <div
          key={item.key}
          className={`rounded-2xl border px-4 py-3 text-sm ${rowToneClasses(item)}`}
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-zinc-100">{item.displayName}</p>
              <p className="mt-1 text-xs text-zinc-500">
                {item.modelId || "Project-wide"}
                {item.limitName ? ` • ${item.limitName}` : ""}
                {item.location ? ` • ${item.location}` : ""}
              </p>
            </div>
            <span
              className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] ${statusChipClasses(item)}`}
            >
              {statusChip(item)}
            </span>
          </div>

          <div className="mt-3 grid gap-2 text-xs text-zinc-300 sm:grid-cols-4">
            <div className="rounded-xl border border-white/10 bg-black/15 px-3 py-2">
              Usage: {formatNumber(item.usage)}
            </div>
            <div className="rounded-xl border border-white/10 bg-black/15 px-3 py-2">
              Limit: {formatNumber(item.limit)}
            </div>
            <div className="rounded-xl border border-white/10 bg-black/15 px-3 py-2">
              Remaining: {formatNumber(item.remaining)}
            </div>
            <div className="rounded-xl border border-white/10 bg-black/15 px-3 py-2">
              Used: {formatPercent(item.usagePercent)}
            </div>
          </div>

          {item.methods?.length > 0 && (
            <p className="mt-3 text-[11px] text-zinc-400">
              Methods: {item.methods.join(", ")}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

export default function UsagePanel({
  usageDashboard,
  isRefreshingUsage,
  onRefresh,
  selectedModelId,
}) {
  const selectedItems =
    usageDashboard?.status === "ok"
      ? usageDashboard.items
          .filter((item) => matchesSelectedModel(item, selectedModelId))
          .slice(0, 4)
      : [];
  const overallItems =
    usageDashboard?.status === "ok" ? usageDashboard.items.slice(0, 10) : [];

  return (
    <section className="mt-4 rounded-3xl border border-white/10 bg-white/[0.03] p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-zinc-200">Usage</h3>
          <p className="mt-1 text-xs text-zinc-500">
            Project quota from Google Cloud Monitoring
          </p>
        </div>
        <button
          className="rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-zinc-300 hover:bg-white/10 disabled:opacity-50"
          onClick={onRefresh}
          disabled={isRefreshingUsage}
        >
          {isRefreshingUsage ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {!usageDashboard && (
        <div className="mt-4 rounded-2xl border border-white/10 bg-[#202020] px-4 py-5 text-sm text-zinc-400">
          Loading usage data...
        </div>
      )}

      {usageDashboard && (
        <>
          <dl className="mt-4 grid gap-3 text-sm text-zinc-400 sm:grid-cols-2">
            <div className="rounded-2xl border border-white/10 bg-[#202020] px-4 py-3">
              <dt className="text-zinc-500">Project</dt>
              <dd className="mt-1 break-all text-zinc-200">
                {usageDashboard.projectId || "Not configured"}
              </dd>
            </div>
            <div className="rounded-2xl border border-white/10 bg-[#202020] px-4 py-3">
              <dt className="text-zinc-500">Checked</dt>
              <dd className="mt-1 text-zinc-200">
                {formatCheckedAt(usageDashboard.checkedAt)}
              </dd>
            </div>
            <div className="rounded-2xl border border-white/10 bg-[#202020] px-4 py-3">
              <dt className="text-zinc-500">Service</dt>
              <dd className="mt-1 break-all text-zinc-200">{usageDashboard.service}</dd>
            </div>
            <div className="rounded-2xl border border-white/10 bg-[#202020] px-4 py-3">
              <dt className="text-zinc-500">Auth</dt>
              <dd className="mt-1 text-zinc-200">
                {usageDashboard.auth?.credentialType || usageDashboard.auth?.method || "n/a"}
              </dd>
            </div>
          </dl>

          {usageDashboard.status === "ok" && (
            <>
              <div className="mt-4 flex flex-wrap gap-2 text-xs text-zinc-300">
                <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1">
                  rows {usageDashboard.summary?.totalItems ?? 0}
                </span>
                <span className="rounded-full border border-red-500/20 bg-red-500/10 px-3 py-1 text-red-200">
                  exhausted {usageDashboard.summary?.exhaustedCount ?? 0}
                </span>
                <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-3 py-1 text-amber-200">
                  near {usageDashboard.summary?.nearLimitCount ?? 0}
                </span>
                <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1">
                  models {usageDashboard.summary?.modelCount ?? 0}
                </span>
              </div>

              {selectedItems.length > 0 && (
                <div className="mt-5">
                  <p className="mb-2 text-xs uppercase tracking-[0.24em] text-zinc-500">
                    Selected model
                  </p>
                  {renderQuotaRows(selectedItems)}
                </div>
              )}

              <div className="mt-5">
                <p className="mb-2 text-xs uppercase tracking-[0.24em] text-zinc-500">
                  Highest risk
                </p>
                {renderQuotaRows(overallItems)}
              </div>
            </>
          )}

          {usageDashboard.status !== "ok" && (
            <div className="mt-4 rounded-2xl border border-amber-500/25 bg-amber-500/10 px-4 py-4 text-sm text-amber-100">
              <p className="font-semibold">
                {usageDashboard.status === "setup_required"
                  ? "Usage setup required"
                  : "Usage lookup failed"}
              </p>
              <p className="mt-2 whitespace-pre-wrap text-amber-100/85">
                {usageDashboard.error?.message || "The server could not fetch quota data."}
              </p>
              {usageDashboard.setup?.instructions?.length > 0 && (
                <ul className="mt-3 list-disc space-y-1 pl-5 text-amber-100/80">
                  {usageDashboard.setup.instructions.map((instruction) => (
                    <li key={instruction}>{instruction}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
