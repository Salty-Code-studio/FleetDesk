"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { api, type ApiError } from "../../client";

export default function AdminLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

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
      <h1>
        FLEET<b style={{ color: "var(--orange)" }}>DESK</b> Admin<span className="brand-dot" />
      </h1>
      <p className="sub">Sign in to the operations dashboard.</p>
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
