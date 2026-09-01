import { createHmac, randomUUID } from "node:crypto";

export const GUEST_COOKIE = "philchat_guest";

export function hashIp(ip, secret) {
  return createHmac("sha256", secret).update(String(ip ?? "")).digest("hex");
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Read the guest's signed cookie, issuing one lazily if this is their first chat request.
 *
 * Issued on the first *chat* request rather than the first page view: the previous
 * implementation set `saveUninitialized: true`, handing a cookie to every visitor who
 * merely loaded the page, which is both a privacy wart and useless for the limit it is
 * meant to enforce.
 */
export function resolveGuest({ request, response, config }) {
  const existing = request.signedCookies?.[GUEST_COOKIE];
  const guestId = typeof existing === "string" && existing ? existing : randomUUID();

  if (guestId !== existing) {
    response.cookie(GUEST_COOKIE, guestId, {
      httpOnly: true,
      // Strict withholds the cookie on a cross-site top-level navigation, but that
      // request only returns index.html; the SPA's own chat request afterwards is
      // same-site and does carry it.
      sameSite: "strict",
      secure: config.isProduction,
      signed: true,
      path: "/",
      maxAge: 365 * 24 * 60 * 60 * 1000,
    });
  }

  return { guestId, ipHash: hashIp(request.ip, config.sessionSecret) };
}

/**
 * Read the guest's identity without issuing a cookie. /api/me runs on page load, and
 * issuing there would reintroduce the cookie-for-every-visitor behaviour.
 */
export function peekGuest({ request, config }) {
  return {
    guestId: request.signedCookies?.[GUEST_COOKIE] ?? null,
    ipHash: hashIp(request.ip, config.sessionSecret),
  };
}

/**
 * Messages already spent by this visitor.
 *
 * Takes the higher of the cookie's count and every count seen from the same hashed IP, so
 * clearing cookies does not hand out a fresh allowance. A VPN or a new mobile IP still
 * defeats this; the global daily cap is the actual spend backstop.
 */
function messagesUsed({ database, guest }) {
  const byGuest = guest.guestId
    ? (database.connection
        .prepare("SELECT messages_used FROM guest_usage WHERE guest_id = ?")
        .get(guest.guestId)?.messages_used ?? 0)
    : 0;

  const byIp =
    database.connection
      .prepare("SELECT SUM(messages_used) AS total FROM guest_usage WHERE ip_hash = ?")
      .get(guest.ipHash)?.total ?? 0;

  return Math.max(Number(byGuest), Number(byIp));
}

export function summarizeGuestAllowance({ database, config, guest }) {
  const used = messagesUsed({ database, guest });
  const dailyUsed =
    database.connection
      .prepare("SELECT guest_messages FROM daily_budget WHERE date = ?")
      .get(todayUTC())?.guest_messages ?? 0;

  return {
    messagesUsed: used,
    messagesLimit: config.guestMessageLimit,
    messagesRemaining: Math.max(0, config.guestMessageLimit - used),
    dailyRemaining: Math.max(0, config.guestDailyMessageLimit - Number(dailyUsed)),
  };
}

export function isModelAllowedForGuests(modelId, config) {
  if (config.guestModelAllowlist.length === 0) return true;
  return config.guestModelAllowlist.includes(modelId);
}

/**
 * Spend one guest message. Both counters move in one transaction, before the upstream
 * stream opens - a guest message is spent whether or not the model answers.
 */
export function consumeGuestMessage({ database, config, guest }) {
  return database.transaction(() => {
    if (messagesUsed({ database, guest }) >= config.guestMessageLimit) {
      return { ok: false, reason: "guest" };
    }

    const today = todayUTC();
    const dailyUsed =
      database.connection
        .prepare("SELECT guest_messages FROM daily_budget WHERE date = ?")
        .get(today)?.guest_messages ?? 0;

    if (Number(dailyUsed) >= config.guestDailyMessageLimit) {
      return { ok: false, reason: "daily" };
    }

    const now = new Date().toISOString();

    database.connection
      .prepare(
        `INSERT INTO guest_usage (guest_id, ip_hash, messages_used, first_seen, last_seen)
         VALUES (?, ?, 1, ?, ?)
         ON CONFLICT(guest_id) DO UPDATE SET
           messages_used = messages_used + 1,
           last_seen = excluded.last_seen`
      )
      .run(guest.guestId, guest.ipHash, now, now);

    database.connection
      .prepare(
        `INSERT INTO daily_budget (date, guest_messages, tokens) VALUES (?, 1, 0)
         ON CONFLICT(date) DO UPDATE SET guest_messages = guest_messages + 1`
      )
      .run(today);

    return { ok: true };
  });
}
