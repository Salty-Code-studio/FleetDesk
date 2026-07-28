"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { api, type ApiError } from "../../client";

const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === "true";

export default function AdminLoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"owner" | "staff">("owner");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function enterDemo() {
    setError("");
    setBusy(true);
    try {
      await api("/api/admin/auth/demo", {});
      router.push("/admin");
    } catch {
      setError("The demo is not available right now. Please try again shortly.");
      setBusy(false);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await api<{ mfaRequired?: boolean; enrollRequired?: boolean }>(
        "/api/admin/auth/login",
        { email, password },
      );
      router.push("/admin/mfa");
    } catch (err) {
      const apiErr = err as ApiError;
      setError(
        apiErr.status === 429
          ? `Too many attempts. Try again in ${apiErr.retryAfter ?? "a few"} seconds.`
          : "Invalid email or password.",
      );
      setBusy(false);
    }
  }

  async function onStaffSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await api("/api/admin/auth/staff-login", { code });
      router.push("/admin");
    } catch (err) {
      const apiErr = err as ApiError;
      setError(
        apiErr.status === 429
          ? `Too many attempts. Try again in ${apiErr.retryAfter ?? "a few"} seconds.`
          : "That code did not work. Check it and try again.",
      );
      setBusy(false);
    }
  }

  function switchMode(next: "owner" | "staff") {
    setMode(next);
    setError("");
    setCode("");
  }

  if (mode === "staff") {
    return (
      <form className="auth-card" onSubmit={onStaffSubmit}>
        <p className="auth-brand">FleetDesk</p>
        <h1>Staff sign in</h1>
        <p className="sub">Enter your personal 6-digit code.</p>
        <div className="field">
          <label htmlFor="staff-code">Staff code</label>
          <input
            id="staff-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            required
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          />
        </div>
        <button className="btn" disabled={busy || code.length !== 6}>
          {busy ? "Signing in…" : "Sign in with code"}
        </button>
        <p className="msg err" role="alert">{error}</p>
        <button type="button" className="btn btn--quiet" onClick={() => switchMode("owner")}>
          Owner sign in with email and password
        </button>
      </form>
    );
  }

  return (
    <form className="auth-card" onSubmit={onSubmit}>
      <p className="auth-brand">FleetDesk</p>
      <h1>Sign in</h1>
      <p className="sub">Welcome back to the operations dashboard.</p>

      {DEMO_MODE && (
        <div className="demo-panel">
          <button type="button" className="btn btn-demo" onClick={enterDemo} disabled={busy}>
            {busy ? "Opening…" : "Enter the live demo →"}
          </button>
          <p className="demo-hint">No sign-in needed. Explore the full operations dashboard with sample data.</p>
          <div className="demo-divider"><span>or sign in</span></div>
        </div>
      )}

      <div className="field">
        <label htmlFor="email">Email</label>
        <input id="email" type="email" autoComplete="username" required
          value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="password">Password</label>
        <input id="password" type="password" autoComplete="current-password" required
          value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      <button className="btn" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
      <p className="msg err" role="alert">{error}</p>
      <button type="button" className="btn btn--quiet" onClick={() => switchMode("staff")}>
        Staff member? Sign in with your code
      </button>
    </form>
  );
}
