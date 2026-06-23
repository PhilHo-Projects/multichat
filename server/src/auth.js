import bcrypt from "bcryptjs";

const PUBLIC_MESSAGE_LIMIT = parseInt(process.env.PUBLIC_MESSAGE_LIMIT || "5", 10);
const PUBLIC_DAILY_LIMIT = parseInt(process.env.PUBLIC_DAILY_LIMIT || "10", 10);

const dailyBucket = { date: null, count: 0 };

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

export function getPublicMessageLimit() {
  return PUBLIC_MESSAGE_LIMIT;
}

export function getDailyLimitStatus() {
  const today = todayUTC();
  if (dailyBucket.date !== today) {
    return { used: 0, limit: PUBLIC_DAILY_LIMIT, date: today };
  }
  return { used: dailyBucket.count, limit: PUBLIC_DAILY_LIMIT, date: dailyBucket.date };
}

export function consumeDailyMessage() {
  const today = todayUTC();
  if (dailyBucket.date !== today) {
    dailyBucket.date = today;
    dailyBucket.count = 0;
  }

  if (dailyBucket.count >= PUBLIC_DAILY_LIMIT) {
    return false;
  }

  dailyBucket.count += 1;
  return true;
}

export function isAuthEnabled() {
  return Boolean(process.env.ADMIN_PASSWORD?.trim());
}

export async function verifyCredentials(username, password) {
  if (!username || !password) return false;

  const adminUsername = process.env.ADMIN_USERNAME?.trim() || "phil";
  const adminPassword = process.env.ADMIN_PASSWORD?.trim() || "";

  const users = [];

  if (adminPassword) {
    users.push({ username: adminUsername, password: adminPassword });
  }

  try {
    const extraJson = process.env.EXTRA_USERS?.trim();
    if (extraJson) {
      const extra = JSON.parse(extraJson);
      if (Array.isArray(extra)) {
        for (const u of extra) {
          if (u.username && u.password) {
            users.push(u);
          }
        }
      }
    }
  } catch {
    // ignore malformed EXTRA_USERS
  }

  const user = users.find((u) => u.username === username);
  if (!user) return false;

  // Support bcrypt hashes ($2b$... / $2a$...) and plaintext
  if (user.password.startsWith("$2")) {
    return bcrypt.compare(password, user.password);
  }

  return user.password === password;
}
