"use client";

import { useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";

// Only allow same-origin, relative redirect targets after login (e.g. "/" or
// "/providers"). Rejects absolute/protocol-relative URLs (e.g.
// "https://evil.example/" or "//evil.example/") that could be used to phish
// a user immediately after they authenticate with the real dashboard
// password, since `next` is attacker-controlled via the query string.
//
// Browsers strip ASCII tab/CR/LF before parsing a URL and treat backslashes
// the same as forward slashes in relative URLs, so a value that looks safe
// here (starts with a single "/") can still resolve to a protocol-relative
// off-site redirect once assigned to window.location.href — e.g.
// "/\evil.example/" is parsed as "//evil.example/" -> https://evil.example/.
// Strip the whitespace trick first, then reject any backslash outright.
function sanitizeNextPath(next: string | null): string {
  if (!next) return "/";
  const stripped = next.replace(/[\t\r\n]/g, "");
  if (stripped.includes("\\")) return "/";
  if (!stripped.startsWith("/") || stripped.startsWith("//")) return "/";
  return stripped;
}

function LoginForm() {
  const searchParams = useSearchParams();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Invalid password");
      }
      const next = sanitizeNextPath(searchParams.get("next"));
      window.location.href = next;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to log in");
      setSubmitting(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-[70vh] px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          {/* Same brand mark as nav / favicon / iOS client app icon */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/icon-64.png"
            alt=""
            width={48}
            height={48}
            className="mx-auto mb-3 h-12 w-12 rounded-xl shadow-sm"
            aria-hidden="true"
            decoding="async"
          />
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">Usage Monitor</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            API &amp; infra spend in one place
          </p>
        </div>

        <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Log In</h2>
          <form onSubmit={handleSubmit} className="mt-4 space-y-4">
            <div>
              <label htmlFor="password" className="block text-xs font-medium text-gray-500 mb-1 dark:text-gray-400">
                Dashboard password
              </label>
              <input
                id="password"
                type="password"
                autoFocus
                autoComplete="current-password"
                aria-describedby={error ? "login-error" : undefined}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter password"
                className="w-full min-h-11 px-3 py-2 border border-gray-300 rounded-lg text-base focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
              />
            </div>
            {error && (
              <p id="login-error" role="alert" className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2 dark:text-red-300 dark:bg-red-950/60">
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={submitting || !password}
              className="w-full min-h-11 px-4 py-2 text-base font-medium text-white bg-accent rounded-lg hover:opacity-90 transition-colors disabled:opacity-50"
            >
              {submitting ? "Logging in…" : "Log In"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

function LoginSkeleton() {
  return (
    <div className="flex items-center justify-center min-h-[70vh]" aria-busy="true" aria-label="Loading login form">
      <div className="w-full max-w-sm rounded-2xl border border-gray-200 bg-white p-6 space-y-4 dark:bg-gray-800 dark:border-gray-700">
        <div className="h-7 w-24 rounded bg-gray-200 dark:bg-gray-700 animate-pulse" />
        <div className="space-y-2">
          <div className="h-3 w-16 rounded bg-gray-200 dark:bg-gray-700 animate-pulse" />
          <div className="h-11 w-full rounded-lg bg-gray-200 dark:bg-gray-700 animate-pulse" />
        </div>
        <div className="h-11 w-full rounded-lg bg-gray-200 dark:bg-gray-700 animate-pulse" />
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<LoginSkeleton />}>
      <LoginForm />
    </Suspense>
  );
}
