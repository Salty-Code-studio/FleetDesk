"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { api, type ApiError } from "../../client";

interface Me { email: string; mfaEnabled: boolean; mfaPending: boolean }
interface Enrollment { qrDataUrl: string; manualKey: string; recoveryCodes: string[] }

export default function AdminMfaPage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [code, setCode] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/admin/auth/me")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("unauthenticated"))))
      .then(setMe)
      .catch(() => router.replace("/admin/login"));
  }, [router]);

  async function startEnrollment() {
    setError("");
    setBusy(true);
    try {
      setEnrollment(await api<Enrollment>("/api/admin/auth/mfa/enroll"));
    } catch {
      setError("Could not start enrollment. Refresh and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (enrollment) {
        await api("/api/admin/auth/mfa/enroll/confirm", { code });
      } else if (useRecovery) {
        await api("/api/admin/auth/mfa/verify", { recoveryCode });
      } else {
        await api("/api/admin/auth/mfa/verify", { code });
      }
      router.push("/admin");
    } catch (err) {
      const apiErr = err as ApiError;
      setError(apiErr.status === 429 ? "Too many attempts. Wait a moment." : "That code didn't work. Try again.");
      setBusy(false);
    }
  }

  if (!me) return <div className="auth-card"><p className="sub">Loading…</p></div>;

  // Enrollment path: mandatory before first use (spec: TOTP is not optional).
  if (!me.mfaEnabled) {
    return (
      <form className="auth-card" onSubmit={onSubmit}>
        <h1>Set up two-step verification</h1>
        <p className="sub">
          Required before you can use the dashboard. Scan the code with Google
          Authenticator, 1Password, or any TOTP app.
        </p>
        {!enrollment ? (
          <button type="button" className="btn" onClick={startEnrollment} disabled={busy}>
            {busy ? "Preparing…" : "Begin setup"}
          </button>
        ) : (
          <>
            <div className="qr-box">
              {/* eslint-disable-next-line @next/next/no-img-element -- inline data URL */}
              <img src={enrollment.qrDataUrl} alt="TOTP enrollment QR code" />
              <span className="manual-key">{enrollment.manualKey}</span>
            </div>
            <div className="recovery">
              <h3>Recovery codes, save them now</h3>
              <ul>{enrollment.recoveryCodes.map((c) => <li key={c}>{c}</li>)}</ul>
              <p>Each works once if you lose your phone. They will never be shown again.</p>
            </div>
            <div className="field">
              <label htmlFor="code">Enter the 6-digit code from your app</label>
              <input id="code" inputMode="numeric" pattern="[0-9]*" maxLength={6} required
                value={code} onChange={(e) => setCode(e.target.value)} />
            </div>
            <button className="btn" disabled={busy}>{busy ? "Checking…" : "Confirm and finish"}</button>
          </>
        )}
        <p className="msg err" role="alert">{error}</p>
      </form>
    );
  }

  // Verification path: second factor at login.
  return (
    <form className="auth-card" onSubmit={onSubmit}>
      <h1>Two-step verification</h1>
      <p className="sub">{me.email}</p>
      {!useRecovery ? (
        <div className="field">
          <label htmlFor="code">6-digit code</label>
          <input id="code" inputMode="numeric" pattern="[0-9]*" maxLength={6} autoFocus required
            value={code} onChange={(e) => setCode(e.target.value)} />
        </div>
      ) : (
        <div className="field">
          <label htmlFor="recovery">Recovery code</label>
          <input id="recovery" autoComplete="off" required
            value={recoveryCode} onChange={(e) => setRecoveryCode(e.target.value)} />
        </div>
      )}
      <button className="btn" disabled={busy}>{busy ? "Checking…" : "Verify"}</button>
      <button type="button" className="btn btn--quiet" onClick={() => { setUseRecovery(!useRecovery); setError(""); }}>
        {useRecovery ? "Use authenticator code instead" : "Use a recovery code"}
      </button>
      <p className="msg err" role="alert">{error}</p>
    </form>
  );
}
