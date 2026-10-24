"use client";

import React, { useEffect, useState } from "react";
import { useAuth } from "./AuthContext";
import { X, Mail, Lock, AlertCircle, Loader2 } from "lucide-react";
import { getAuthProviders } from "@/lib/api";

function GitHubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor" className={className}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export function AuthModal() {
  const { isAuthModalOpen, closeAuthModal, modalMode, setModalMode, login, register, loginWithGitHub, githubError } = useAuth();
  const [githubEnabled, setGithubEnabled] = useState<boolean | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isAuthModalOpen) return;
    getAuthProviders()
      .then((p) => setGithubEnabled(p.github))
      .catch(() => setGithubEnabled(false));
  }, [isAuthModalOpen]);

  if (!isAuthModalOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Gmail regex check
    const gmailRegex = /^[a-zA-Z0-9._%+-]+@gmail\.com$/i;
    if (!gmailRegex.test(email.trim())) {
      setError("Please enter a valid Gmail address (e.g. yourname@gmail.com)");
      return;
    }

    if (password.length < 6) {
      setError("Password must be at least 6 characters long.");
      return;
    }

    setLoading(true);
    try {
      if (modalMode === "login") {
        await login(email.trim(), password);
      } else {
        await register(email.trim(), password);
      }
      setEmail("");
      setPassword("");
    } catch (err: any) {
      setError(err.message || "Authentication failed. Please verify credentials.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-ink/70 backdrop-blur-sm animate-fade-in">
      <div className="relative w-full max-w-md bg-paper border border-ink/20 rounded-2xl shadow-2xl p-6 sm:p-8 text-ink">
        <button
          onClick={closeAuthModal}
          className="absolute top-4 right-4 p-1.5 rounded-lg text-ink/50 hover:text-ink hover:bg-ink/5 transition-colors"
        >
          <X className="w-5 h-5" />
        </button>

        <div className="mb-6">
          <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full text-xs font-mono font-medium bg-butter/30 text-ink mb-2">
            <span>Powered by Neon PostgreSQL</span>
          </div>
          <h2 className="text-2xl font-display font-bold">
            {modalMode === "login" ? "Welcome back" : "Create your account"}
          </h2>
          <p className="text-sm text-ink/70 mt-1">
            {modalMode === "login"
              ? "Sign in with your @gmail.com account"
              : "Register using your @gmail.com address"}
          </p>
        </div>

        {(error || githubError) && (
          <div className="mb-4 p-3 rounded-xl bg-danger/10 border border-danger/20 flex items-start gap-2.5 text-danger text-sm">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{error || githubError}</span>
          </div>
        )}

        <button
          type="button"
          onClick={loginWithGitHub}
          disabled={githubEnabled === false}
          title={githubEnabled === false ? "GitHub login is not configured on the server" : undefined}
          className="w-full mb-4 py-2.5 px-4 rounded-xl font-medium text-sm text-white bg-[#24292f] hover:bg-[#24292f]/90 active:scale-[0.99] transition-all flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed shadow-md"
        >
          <GitHubMark className="w-4 h-4" />
          Continue with GitHub
        </button>
        {githubEnabled === false && (
          <p className="-mt-2 mb-3 text-[11px] text-ink/50 font-mono text-center">
            Not configured: set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET in .env
          </p>
        )}
        <div className="flex items-center gap-3 mb-4 text-[11px] font-mono text-ink/40">
          <span className="h-px flex-1 bg-ink/10" /> or use email <span className="h-px flex-1 bg-ink/10" />
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-mono font-medium text-ink/70 mb-1.5">
              Gmail Address
            </label>
            <div className="relative">
              <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-ink/40" />
              <input
                type="email"
                required
                placeholder="developer@gmail.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-ink/20 bg-white/70 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo/40 focus:border-indigo text-sm font-sans placeholder:text-ink/30 transition-all"
              />
            </div>
            <p className="text-[11px] text-ink/50 mt-1 font-mono">Must match: *@gmail.com</p>
          </div>

          <div>
            <label className="block text-xs font-mono font-medium text-ink/70 mb-1.5">
              Password
            </label>
            <div className="relative">
              <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-ink/40" />
              <input
                type="password"
                required
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-ink/20 bg-white/70 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo/40 focus:border-indigo text-sm font-sans placeholder:text-ink/30 transition-all"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 px-4 rounded-xl font-medium text-sm text-white bg-ink hover:bg-ink/90 active:scale-[0.99] transition-all flex items-center justify-center gap-2 disabled:opacity-50 shadow-md"
          >
            {loading && <Loader2 className="w-4 h-4 animate-spin" />}
            {modalMode === "login" ? "Sign In" : "Register Account"}
          </button>
        </form>

        <div className="mt-6 pt-4 border-t border-ink/10 text-center text-xs text-ink/70">
          {modalMode === "login" ? (
            <p>
              Don't have an account yet?{" "}
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setModalMode("register");
                }}
                className="font-medium text-indigo underline hover:text-indigo/80 ml-1"
              >
                Sign up
              </button>
            </p>
          ) : (
            <p>
              Already have an account?{" "}
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setModalMode("login");
                }}
                className="font-medium text-indigo underline hover:text-indigo/80 ml-1"
              >
                Sign in
              </button>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
