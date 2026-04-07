import { FormEvent, useState, useEffect } from "react";

const STORAGE_KEY = "nc_saved_pw";
const STORAGE_EXPIRY_KEY = "nc_saved_pw_expiry";
const EXPIRY_DAYS = 90;

interface LoginPageProps {
  onLogin: () => void;
}

export default function LoginPage({ onLogin }: LoginPageProps) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function tryLogin(pw: string, silent = false) {
    if (!silent) setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw }),
      });
      if (res.ok) {
        const expiry = Date.now() + EXPIRY_DAYS * 24 * 60 * 60 * 1000;
        localStorage.setItem(STORAGE_KEY, pw);
        localStorage.setItem(STORAGE_EXPIRY_KEY, String(expiry));
        onLogin();
      } else {
        if (!silent) {
          const data = await res.json().catch(() => ({}));
          setError(data.error ?? "Invalid password");
        } else {
          // Saved password no longer valid — clear it
          localStorage.removeItem(STORAGE_KEY);
          localStorage.removeItem(STORAGE_EXPIRY_KEY);
        }
      }
    } catch {
      if (!silent) setError("Connection failed");
    } finally {
      if (!silent) setLoading(false);
    }
  }

  // Auto-login with saved password on mount
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    const expiry = Number(localStorage.getItem(STORAGE_EXPIRY_KEY) ?? 0);
    if (saved && Date.now() < expiry) {
      tryLogin(saved, true);
    }
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    await tryLogin(password);
  }

  return (
    <div className="flex h-screen items-center justify-center bg-gray-950">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-500/20 text-indigo-400 font-bold">
            NC
          </div>
          <h1 className="text-xl font-semibold text-gray-100">NanoClaw</h1>
          <p className="mt-1 text-sm text-gray-500">Command Center</p>
        </div>

        <form onSubmit={handleSubmit} className="rounded-xl border border-gray-800 bg-gray-900 p-6">
          <label htmlFor="password" className="mb-2 block text-sm font-medium text-gray-400">
            Password
          </label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mb-4 w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
            placeholder="Enter password"
            autoFocus
          />

          {error && (
            <p className="mb-4 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-400">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
          >
            {loading ? "Signing in..." : "Sign In"}
          </button>
        </form>
      </div>
    </div>
  );
}
