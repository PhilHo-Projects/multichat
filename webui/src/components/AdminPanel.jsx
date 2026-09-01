/* eslint-disable react/prop-types */
import { useCallback, useEffect, useState } from "react";

import { fetchAdminUsers, setUserApproval, setUserBudget } from "../lib/api";

export default function AdminPanel({ onClose }) {
  const [users, setUsers] = useState([]);
  const [status, setStatus] = useState("pending");
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async (nextStatus) => {
    try {
      const payload = await fetchAdminUsers(nextStatus);
      setUsers(payload.users);
      setError(null);
    } catch (caught) {
      setError(caught.message);
    }
  }, []);

  useEffect(() => {
    void load(status);
  }, [load, status]);

  async function act(id, action) {
    setBusyId(id);
    try {
      await action();
      await load(status);
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="max-h-[80vh] w-full max-w-[640px] overflow-y-auto rounded-[28px] border border-white/10 bg-[#171717] px-6 py-7 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-5 flex items-center justify-between">
          <p className="text-xs uppercase tracking-[0.28em] text-zinc-500">Accounts</p>
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            className="rounded-xl border border-white/10 bg-[#222222] px-3 py-1.5 text-xs text-zinc-300"
          >
            <option value="pending">Pending</option>
            <option value="all">All</option>
          </select>
        </div>

        {error && (
          <p className="mb-4 rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            {error}
          </p>
        )}

        {users.length === 0 && (
          <p className="py-8 text-center text-sm text-zinc-500">Nothing waiting.</p>
        )}

        <ul className="space-y-3">
          {users.map((user) => (
            <li
              key={user.id}
              className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3"
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm text-zinc-100">
                    {user.username}
                    <span className="ml-2 text-xs text-zinc-500">{user.email}</span>
                  </p>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    {user.approvalStatus} · {user.tokensUsed.toLocaleString()} /{" "}
                    {user.tokenBudget.toLocaleString()} tokens this month
                  </p>
                </div>

                {user.role !== "owner" && (
                  <div className="flex shrink-0 gap-2">
                    <button
                      type="button"
                      disabled={busyId === user.id || user.approvalStatus === "approved"}
                      onClick={() => act(user.id, () => setUserApproval(user.id, true))}
                      className="rounded-xl bg-emerald-500/15 px-3 py-1.5 text-xs text-emerald-300 disabled:opacity-40"
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      disabled={busyId === user.id || user.approvalStatus === "rejected"}
                      onClick={() => act(user.id, () => setUserApproval(user.id, false))}
                      className="rounded-xl bg-red-500/15 px-3 py-1.5 text-xs text-red-300 disabled:opacity-40"
                    >
                      Reject
                    </button>
                  </div>
                )}
              </div>

              {user.role !== "owner" && (
                <form
                  className="mt-3 flex gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const raw = new FormData(event.currentTarget).get("budget");
                    const value = String(raw).trim();
                    void act(user.id, () =>
                      setUserBudget(user.id, value === "" ? null : Number(value))
                    );
                  }}
                >
                  <input
                    name="budget"
                    type="number"
                    min="0"
                    step="1000"
                    placeholder={`default (${user.tokenBudget.toLocaleString()})`}
                    defaultValue={user.monthlyTokenBudget ?? ""}
                    className="flex-1 rounded-xl border border-white/10 bg-[#222222] px-3 py-1.5 text-xs text-zinc-200"
                  />
                  <button
                    type="submit"
                    disabled={busyId === user.id}
                    className="rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-zinc-300 disabled:opacity-40"
                  >
                    Set budget
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>

        <button
          type="button"
          onClick={onClose}
          className="mt-5 w-full rounded-2xl border border-white/10 bg-white/5 py-3 text-sm text-zinc-400 transition hover:bg-white/10"
        >
          Close
        </button>
      </div>
    </div>
  );
}
