"use client";

import { useEffect, useState } from "react";

/** Magic-link landing: ?email&code from the email. Verifies and redirects. */
export default function VerifyPage() {
  const [error, setError] = useState("");

  useEffect(() => {
    // The code is in the URL fragment (kept off the server/Referer). Read it,
    // then immediately strip it from the address bar + history.
    const hash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "";
    const p = new URLSearchParams(hash || window.location.search);
    const email = p.get("email"), code = p.get("code");
    window.history.replaceState(null, "", "/account/verify");
    if (!email || !code) { setError("This link is incomplete."); return; }
    fetch("/api/auth/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, code }) })
      .then((r) => { if (r.ok) window.location.href = "/account"; else setError("This link is invalid or has expired."); })
      .catch(() => setError("Network error. Please try again."));
  }, []);

  return (
    <div className="wrap" style={{ maxWidth: 440 }}>
      <div className="card">
        <h2>Signing you in…</h2>
        {error ? <p className="msg err">{error} <a href="/account/login">Try again</a></p> : <p className="note">One moment.</p>}
      </div>
    </div>
  );
}
