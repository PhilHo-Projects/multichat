import { useRef, useState } from "react";

export default function LoginModal({ onLogin, onClose, limitReached, messagesLimit }) {
  const usernameRef = useRef(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [isLoading, setIsLoading] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    if (!username.trim() || !password) return;

    setIsLoading(true);
    setError(null);

    try {
      await onLogin(username.trim(), password);
    } catch (err) {
      setError(err.payload?.message || err.message || "Login failed.");
      usernameRef.current?.focus();
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[400px] rounded-[28px] border border-white/10 bg-[#171717] px-6 py-7 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {limitReached ? (
          <div className="mb-5 rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
            <p className="font-semibold">Guest limit reached</p>
            <p className="mt-1 text-amber-200/80">
              You&apos;ve used all {messagesLimit} guest messages. Sign in for unlimited access.
            </p>
          </div>
        ) : (
          <p className="mb-5 text-xs uppercase tracking-[0.28em] text-zinc-500">Sign in</p>
        )}

        <form onSubmit={handleSubmit} className="space-y-3">
          <input
            ref={usernameRef}
            type="text"
            placeholder="Username"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={isLoading}
            className="w-full rounded-2xl border border-white/10 bg-[#222222] px-4 py-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-white/20 disabled:opacity-50"
          />
          <input
            type="password"
            placeholder="Password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={isLoading}
            className="w-full rounded-2xl border border-white/10 bg-[#222222] px-4 py-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-white/20 disabled:opacity-50"
          />

          {error && (
            <p className="rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={isLoading || !username.trim() || !password}
            className="w-full rounded-2xl bg-zinc-200 py-3 text-sm font-medium text-zinc-950 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isLoading ? "Signing in…" : "Sign in"}
          </button>
        </form>

        {!limitReached && (
          <button
            type="button"
            onClick={onClose}
            className="mt-3 w-full rounded-2xl border border-white/10 bg-white/5 py-3 text-sm text-zinc-400 transition hover:bg-white/10"
          >
            Continue as guest
          </button>
        )}
      </div>
    </div>
  );
}
