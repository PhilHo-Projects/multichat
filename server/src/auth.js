import bcrypt from "bcryptjs";

const PUBLIC_MESSAGE_LIMIT = parseInt(process.env.PUBLIC_MESSAGE_LIMIT || "5", 10);

export function getPublicMessageLimit() {
  return PUBLIC_MESSAGE_LIMIT;
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
