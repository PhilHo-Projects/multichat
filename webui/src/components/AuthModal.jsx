/* eslint-disable react/prop-types */
import { useState } from "react";

import { authClient } from "../lib/authClient";

const NOTICES = {
  guestLimit: {
    title: "Guest limit reached",
    body: "You've used all your guest messages. Create an account to keep going — new accounts are approved by hand.",
  },
  budget: {
    title: "Token budget used up",
    body: "You've used your token budget for this month. Ask Phil to raise it.",
  },
  pending: {
    title: "Waiting for approval",
    body: "Your account exists but is waiting to be approved. You'll be able to sign in once it is.",
  },
};

const INPUT_CLASS =
  "w-full rounded-2xl border border-white/10 bg-[#222222] px-4 py-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-white/20 disabled:opacity-50";

export default function AuthModal({
  onClose,
  onSignedIn,
  initialNotice = null,
  dismissable = true,
}) {
  const [mode, setMode] = useState("signIn");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [notice, setNotice] = useState(initialNotice);
  const [error, setError] = useState(null);
  const [isLoading, setIsLoading] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setIsLoading(true);
    setError(null);

    try {
      if (mode === "signUp") {
        const { error: signUpError } = await authClient.signUp.email({
          email: email.trim(),
          name: username.trim(),
          username: username.trim(),
          password,
        });

        if (signUpError) throw new Error(signUpError.message);

        // Sign-up never mints a session, so there is nothing to do but wait.
        setMode("signIn");
        setNotice("pending");
        setPassword("");
        return;
      }

      const { error: signInError } = await authClient.signIn.username({
        username: username.trim(),
        password,
      });

      if (signInError) {
        // The approval gate answers with these codes; anything else is a bad credential.
        if (signInError.code === "ACCOUNT_PENDING") {
          setNotice("pending");
          return;
        }
        if (signInError.code === "ACCOUNT_REJECTED") {
          setError("This account cannot sign in.");
          return;
        }
        throw new Error(signInError.message);
      }

      await onSignedIn();
    } catch (caught) {
      setError(caught.message || "Something went wrong.");
    } finally {
      setIsLoading(false);
    }
  }

  const activeNotice = notice ? NOTICES[notice] : null;
  const canSubmit =
    username.trim() && password && (mode === "signIn" || email.trim());

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={dismissable ? onClose : undefined}
    >
      <div
        className="w-full max-w-[400px] rounded-[28px] border border-white/10 bg-[#171717] px-6 py-7 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        {activeNotice && (
          <div className="mb-5 rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
            <p className="font-semibold">{activeNotice.title}</p>
            <p className="mt-1 text-amber-200/80">{activeNotice.body}</p>
          </div>
        )}

        <div className="mb-5 flex gap-2">
          {["signIn", "signUp"].map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => {
                setMode(value);
                setError(null);
              }}
              className={`flex-1 rounded-2xl py-2 text-xs uppercase tracking-[0.2em] transition ${
                mode === value
                  ? "bg-zinc-200 text-zinc-950"
                  : "border border-white/10 bg-white/5 text-zinc-400 hover:bg-white/10"
              }`}
            >
              {value === "signIn" ? "Sign in" : "Sign up"}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <input
            type="text"
            placeholder="Username"
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            disabled={isLoading}
            className={INPUT_CLASS}
          />

          {mode === "signUp" && (
            <input
              type="email"
              placeholder="Email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={isLoading}
              className={INPUT_CLASS}
            />
          )}

          <input
            type="password"
            placeholder={mode === "signUp" ? "Password (12+ characters)" : "Password"}
            autoComplete={mode === "signUp" ? "new-password" : "current-password"}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={isLoading}
            className={INPUT_CLASS}
          />

          {error && (
            <p className="rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={isLoading || !canSubmit}
            className="w-full rounded-2xl bg-zinc-200 py-3 text-sm font-medium text-zinc-950 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isLoading ? "Working…" : mode === "signUp" ? "Create account" : "Sign in"}
          </button>
        </form>

        {mode === "signUp" && (
          <p className="mt-3 text-center text-xs text-zinc-500">
            New accounts are approved by hand before they can sign in.
          </p>
        )}

        {dismissable && (
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
