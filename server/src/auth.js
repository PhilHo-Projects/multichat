import { APIError, betterAuth } from "better-auth";
import { username } from "better-auth/plugins";

/**
 * Better Auth owns identity entirely; there is no second auth path.
 *
 * It is handed the app's own DatabaseSync, so its tables live in the same SQLite file as
 * the usage tables - one backup covers both, and usage_events.user_id can be a real
 * foreign key.
 */
export function buildAuth({ connection, config }) {
  const isProduction = config.isProduction;

  return betterAuth({
    database: connection,
    secret: config.sessionSecret,
    baseURL: config.publicOrigin,
    trustedOrigins: [config.publicOrigin.replace(/\/$/, "")],

    emailAndPassword: {
      enabled: true,
      // Sign-up must never mint a session. Together with the gate below, this guarantees
      // a pending user never holds one at any point in their lifecycle.
      autoSignIn: false,
      minPasswordLength: 12,
      // The address is collected but deliberately never verified - the owner's approval
      // is the human check, so there is no SMTP dependency anywhere in this app.
      requireEmailVerification: false,
    },

    session: {
      expiresIn: config.sessionMaxAgeSeconds,
    },

    user: {
      additionalFields: {
        // `input: false` marks these server-owned: Better Auth strips them from any
        // request body, so a sign-up POST carrying "role":"owner" cannot escalate.
        // Privilege escalation is closed by construction rather than by vigilance.
        role: { type: "string", required: true, defaultValue: "member", input: false },
        approvalStatus: {
          type: "string",
          required: true,
          defaultValue: "pending",
          input: false,
        },
        approvedAt: { type: "string", required: false, input: false },
        approvedBy: { type: "string", required: false, input: false },
        // null means "use DEFAULT_MONTHLY_TOKEN_BUDGET"; a number overrides it per user.
        monthlyTokenBudget: { type: "number", required: false, input: false },
      },
    },

    databaseHooks: {
      session: {
        create: {
          /**
           * The approval gate, and the only one in the codebase.
           *
           * Because it sits at session creation, the existence of a session proves the
           * user is approved - no downstream route re-checks, and there is no
           * half-authenticated state for an authorization bug to hide in.
           */
          before: async (session) => {
            const row = connection
              .prepare('SELECT "approvalStatus" FROM "user" WHERE "id" = ?')
              .get(session.userId);

            if (row?.approvalStatus === "pending") {
              throw new APIError("FORBIDDEN", {
                code: "ACCOUNT_PENDING",
                message: "This account is waiting to be approved.",
              });
            }

            if (row?.approvalStatus !== "approved") {
              throw new APIError("FORBIDDEN", {
                code: "ACCOUNT_REJECTED",
                message: "This account cannot sign in.",
              });
            }

            return { data: session };
          },
        },
      },
    },

    rateLimit: {
      enabled: true,
      // Database storage, so counters survive a restart instead of resetting to zero on
      // every deploy the way an in-process limiter does.
      storage: "database",
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/username": { window: 15 * 60, max: 5 },
        "/sign-in/email": { window: 15 * 60, max: 5 },
        // Public sign-up is a spam vector the old single-password login never had.
        "/sign-up/email": { window: 60 * 60, max: 3 },
      },
    },

    advanced: {
      /**
       * Counterintuitive but deliberate: `useSecureCookies` controls only Better Auth's
       * automatic `__Secure-` name prefix, not the Secure attribute itself. Leaving it
       * false and setting `secure` explicitly below is the only way to get a literal
       * `__Host-` name - with it true the cookie is emitted as
       * `__Secure-__Host-philchat_session`, which browsers read as a plain `__Secure-`
       * cookie, silently losing the stronger subdomain-overwrite guarantee.
       */
      useSecureCookies: false,
      defaultCookieAttributes: {
        httpOnly: true,
        // Strict withholds the cookie on a cross-site top-level navigation, but that
        // request only returns index.html; the SPA's own session fetch afterwards is
        // same-site and does carry it. Costs nothing, blocks CSRF outright.
        sameSite: "strict",
        path: "/",
        secure: isProduction,
      },
      cookies: {
        // `__Host-` additionally requires Secure, Path=/ and no Domain - all satisfied
        // above. It is dropped outside production, where Secure is not set.
        session_token: {
          name: isProduction ? "__Host-philchat_session" : "philchat_session",
        },
      },
    },

    plugins: [username({ minUsernameLength: 3, maxUsernameLength: 30 })],
  });
}
