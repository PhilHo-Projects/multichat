import { monthStartISO } from "./budget.js";

function errorPayload(code, message) {
  return { error: { code, message } };
}

/**
 * An explicit column list, never SELECT *: the user table holds fields with no business
 * on the wire, so a column added later must be opted into deliberately.
 */
export function listUsers({ database, config, status }) {
  const rows = database.connection
    .prepare(
      `SELECT u."id", u."username", u."displayUsername", u."email", u."createdAt",
              u."approvalStatus", u."role", u."approvedAt", u."monthlyTokenBudget",
              (SELECT COALESCE(SUM(e.total_tokens), 0)
                 FROM usage_events e
                WHERE e.user_id = u."id" AND e.created_at >= ?) AS tokensUsed
         FROM "user" u
         ${status === "all" ? "" : `WHERE u."approvalStatus" = 'pending'`}
         ORDER BY CASE u."approvalStatus" WHEN 'pending' THEN 0 ELSE 1 END,
                  u."createdAt" DESC`
    )
    .all(monthStartISO());

  return rows.map((row) => ({
    ...row,
    tokensUsed: Number(row.tokensUsed),
    tokenBudget:
      typeof row.monthlyTokenBudget === "number"
        ? row.monthlyTokenBudget
        : config.defaultMonthlyTokenBudget,
  }));
}

export function setApprovalStatus({ database, id, status, actorId }) {
  const target = database.connection
    .prepare('SELECT "id", "role" FROM "user" WHERE "id" = ?')
    .get(id);

  if (!target) {
    return { ok: false, code: "NOT_FOUND" };
  }

  // The owner cannot lock themselves out of their own admin panel.
  if (target.role === "owner") {
    return { ok: false, code: "CONFLICT" };
  }

  database.transaction(() => {
    database.connection
      .prepare(
        `UPDATE "user" SET "approvalStatus" = ?, "approvedAt" = ?, "approvedBy" = ?
         WHERE "id" = ?`
      )
      .run(status, new Date().toISOString(), actorId ?? null, id);

    // Revocation is the whole point of server-side sessions: a rejected user's live
    // session dies now rather than lasting until its token happens to expire.
    if (status === "rejected") {
      database.connection.prepare('DELETE FROM session WHERE "userId" = ?').run(id);
    }
  });

  return { ok: true, id, approvalStatus: status };
}

export function setUserBudget({ database, id, monthlyTokenBudget }) {
  const target = database.connection
    .prepare('SELECT "id" FROM "user" WHERE "id" = ?')
    .get(id);

  if (!target) {
    return { ok: false, code: "NOT_FOUND" };
  }

  database.connection
    .prepare(`UPDATE "user" SET "monthlyTokenBudget" = ? WHERE "id" = ?`)
    .run(monthlyTokenBudget, id);

  return { ok: true, id, monthlyTokenBudget };
}

/**
 * Owner-only. The default-deny middleware in index.js already turns anonymous callers
 * away, so this only has to separate a member from the owner.
 */
function requireOwner(request, response) {
  if (request.isOwner) return true;
  response.status(403).json(errorPayload("FORBIDDEN", "Owner access required."));
  return false;
}

export function registerAdminRoutes(router, { database, config }) {
  router.get("/api/admin/users", (request, response) => {
    if (!requireOwner(request, response)) return;

    const status = request.query.status === "all" ? "all" : "pending";
    response.json({ users: listUsers({ database, config, status }) });
  });

  const setStatusRoute = (status) => (request, response) => {
    if (!requireOwner(request, response)) return;

    const result = setApprovalStatus({
      database,
      id: request.params.id,
      status,
      actorId: request.authUser?.id ?? null,
    });

    if (result.ok) {
      response.json(result);
      return;
    }

    response
      .status(result.code === "NOT_FOUND" ? 404 : 409)
      .json(
        errorPayload(
          result.code,
          result.code === "NOT_FOUND"
            ? "User not found."
            : "The owner cannot be changed."
        )
      );
  };

  router.post("/api/admin/users/:id/approve", setStatusRoute("approved"));
  router.post("/api/admin/users/:id/reject", setStatusRoute("rejected"));

  router.patch("/api/admin/users/:id/budget", (request, response) => {
    if (!requireOwner(request, response)) return;

    const raw = request.body?.monthlyTokenBudget;
    const parsedValue = raw === null || raw === undefined ? null : Number(raw);

    if (parsedValue !== null && (!Number.isInteger(parsedValue) || parsedValue < 0)) {
      response
        .status(400)
        .json(
          errorPayload(
            "BAD_REQUEST",
            "monthlyTokenBudget must be a non-negative integer or null."
          )
        );
      return;
    }

    const result = setUserBudget({
      database,
      id: request.params.id,
      monthlyTokenBudget: parsedValue,
    });

    if (result.ok) {
      response.json(result);
      return;
    }

    response.status(404).json(errorPayload("NOT_FOUND", "User not found."));
  });
}
