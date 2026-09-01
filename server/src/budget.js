import { randomUUID } from "node:crypto";

export function monthStartISO(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

function todayUTC(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

export function effectiveBudget(user, config) {
  const override = user?.monthlyTokenBudget;
  return typeof override === "number" && override >= 0
    ? override
    : config.defaultMonthlyTokenBudget;
}

function tokensUsedThisMonth({ database, user }) {
  const row = database.connection
    .prepare(
      `SELECT COALESCE(SUM(total_tokens), 0) AS total
       FROM usage_events
       WHERE user_id = ? AND created_at >= ?`
    )
    .get(user.id, monthStartISO());

  return Number(row?.total ?? 0);
}

function tokensUsedToday({ database }) {
  const row = database.connection
    .prepare("SELECT tokens FROM daily_budget WHERE date = ?")
    .get(todayUTC());

  return Number(row?.tokens ?? 0);
}

export function summarizeUserBudget({ database, config, user }) {
  const tokensUsed = tokensUsedThisMonth({ database, user });
  const tokenBudget = effectiveBudget(user, config);

  return {
    tokensUsed,
    tokenBudget,
    tokensRemaining: Math.max(0, tokenBudget - tokensUsed),
  };
}

/**
 * Pre-flight only. Usage arrives at the end of a stream, so a user's final message can
 * overshoot their cap by one response. Estimating tokens up front would be wrong in both
 * directions; the overshoot is bounded by one message and is accepted.
 */
export function checkBudget({ database, config, user }) {
  if (tokensUsedToday({ database }) >= config.globalDailyTokenLimit) {
    return { ok: false, scope: "global" };
  }

  // The owner is exempt from the per-user cap but is still metered, and is still subject
  // to the global ceiling above.
  if (
    user.role !== "owner" &&
    tokensUsedThisMonth({ database, user }) >= effectiveBudget(user, config)
  ) {
    return { ok: false, scope: "user" };
  }

  return { ok: true };
}

export function recordUsage({ database, usage, user, guest, provider, modelId }) {
  if (!usage) return;

  const total = Number(usage.totalTokenCount ?? 0);
  const now = new Date();

  database.transaction(() => {
    database.connection
      .prepare(
        `INSERT INTO usage_events
           (id, user_id, guest_id, provider, model_id,
            prompt_tokens, completion_tokens, total_tokens, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        randomUUID(),
        user?.id ?? null,
        guest?.guestId ?? null,
        provider ?? "unknown",
        modelId ?? "unknown",
        usage.promptTokenCount ?? null,
        usage.candidatesTokenCount ?? null,
        total || null,
        now.toISOString()
      );

    database.connection
      .prepare(
        `INSERT INTO daily_budget (date, guest_messages, tokens) VALUES (?, 0, ?)
         ON CONFLICT(date) DO UPDATE SET tokens = tokens + excluded.tokens`
      )
      .run(todayUTC(now), total);
  });
}
