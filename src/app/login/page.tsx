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
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="w-full max-w-sm bg-white rounded-xl border border-gray-200 p-6 space-y-4">
        <h1 className="text-xl font-bold text-gray-900">Log in</h1>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="password" className="block text-xs text-gray-500 mb-1">
              Password
            </label>
            <input
              id="password"
              type="password"
              autoFocus
              autoComplete="current-password"
              aria-describedby={error ? "login-error" : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Dashboard password"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          {error && (
            <p id="login-error" role="alert" className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={submitting || !password}
            className="w-full px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
          >
            {submitting ? "Logging in..." : "Log in"}
          </button>
        </form>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
