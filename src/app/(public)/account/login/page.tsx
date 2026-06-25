"use client";

import { useState, type FormEvent } from "react";

export default function CustomerLoginPage() {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function request(e: FormEvent) {
    e.preventDefault();
    setError(""); setBusy(true);
    try {
      await fetch("/api/auth/request", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
      setSent(true); // always generic so we never reveal whether the email is known
    } catch { setError("Network error. Please try again."); }
    finally { setBusy(false); }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    setError(""); setBusy(true);
    try {
      const res = await fetch("/api/auth/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, code }) });
      if (!res.ok) { setError("That code is invalid or has expired."); setBusy(false); return; }
      window.location.href = "/account";
    } catch { setError("Network error. Please try again."); setBusy(false); }
  }

  return (
    <div className="wrap" style={{ maxWidth: 440 }}>
      <div className="card">
        <h2>Sign in to your bookings</h2>
        {!sent ? (
          <form onSubmit={request}>
            <p className="note" style={{ marginBottom: "1rem" }}>No password needed. We email you a 6-digit code.</p>
            <label className="fld">Email<input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
            <button className="btn" disabled={busy}>{busy ? "Sending…" : "Email me a code"}</button>
          </form>
        ) : (
          <form onSubmit={verify}>
            <p className="note" style={{ marginBottom: "1rem" }}>We sent a code to <strong>{email}</strong>. Enter it below.</p>
            <label className="fld">6-digit code<input inputMode="numeric" pattern="[0-9]*" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value)} /></label>
            <button className="btn" disabled={busy}>{busy ? "Checking…" : "Sign in"}</button>
            <button type="button" className="btn btn-quiet" style={{ width: "100%", marginTop: ".5rem" }} onClick={() => { setSent(false); setCode(""); }}>Use a different email</button>
          </form>
        )}
        <p className="msg err" style={{ marginTop: ".75rem" }}>{error}</p>
      </div>
    </div>
  );
}
