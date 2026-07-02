"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { api, type ApiError } from "../../client";

const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === "true";

export default function AdminLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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
    </form>
  );
}
