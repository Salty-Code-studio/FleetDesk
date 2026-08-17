"use client";

import { use, useEffect, useState } from "react";

interface Summary { status: string; decidedBy: string | null; message: string }
interface Outcome { outcome: string; decidedBy?: string }

type ViewState = "loading" | "ready" | "gone" | "done" | "busy";

/** Email-link review page: shows the booking summary and asks for one real
 *  click. Links never mutate (mail scanners follow them); this page's POST is
 *  the actual decision. */
export default function ApprovePage({ params, searchParams }: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ action?: string }>;
}) {
  const { token } = use(params);
  const { action } = use(searchParams);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [state, setState] = useState<ViewState>("loading");
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  useEffect(() => {
    fetch(`/api/approval/${encodeURIComponent(token)}`)
      .then(async (r) => {
        if (!r.ok) { setState("gone"); return; }
        setSummary(await r.json());
        setState("ready");
      })
      .catch(() => setState("gone"));
  }, [token]);

  async function decide(a: "confirm" | "decline") {
    setState("busy");
    try {
      const r = await fetch("/api/approval/decide", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, action: a }),
      });
      setOutcome(r.ok ? await r.json() : { outcome: "not_found" });
    } catch {
      // Network hiccup mid-decide: the request may or may not have landed.
      // Fall back to the same "open the admin" copy as an expired link rather
      // than leaving the page stuck on "busy" forever.
      setOutcome({ outcome: "not_found" });
    }
    setState("done");
  }

  function doneMessage(): string {
    switch (outcome?.outcome) {
      case "confirmed":
        return "Done. The booking is confirmed and the customer got their email.";
      case "declined":
        return "Done. The booking is declined and the dates are free again.";
      case "already_handled":
        return `Already handled by ${outcome.decidedBy ?? "the team"}. Nothing else to do.`;
      default:
        // expired / not_found
        return "This link expired. Open the admin to manage the booking.";
    }
  }

  function heading(): string {
    if (state !== "done") return "Booking review";
    switch (outcome?.outcome) {
      case "confirmed": return "Booking confirmed";
      case "declined": return "Booking declined";
      case "already_handled": return "Already handled";
      default: return "Link expired";
    }
  }

  function icon(): string {
    if (state === "gone") return "⏳";
    if (state !== "done") return "📋";
    switch (outcome?.outcome) {
      case "confirmed": return "✅";
      case "declined": return "🚫";
      case "already_handled": return "ℹ️";
      default: return "⏳";
    }
  }

  const showSummary = (state === "ready" || state === "busy") && summary !== null;

  return (
    <div className="wrap confirm">
      <div className="card">
        <div className="big" aria-hidden="true">{icon()}</div>
        <h1>{heading()}</h1>
        {state === "loading" && <p className="note">Loading…</p>}
        {state === "gone" && <p>This link is not valid anymore. Open the admin to manage bookings.</p>}
        {showSummary && summary && (
          <>
            <p style={{ whiteSpace: "pre-line", textAlign: "left" }}>{summary.message}</p>
            {summary.status !== "open" ? (
              <p className="note">Already handled by {summary.decidedBy ?? "the team"}.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem", marginTop: "1.25rem" }}>
                <button
                  type="button"
                  className={action === "decline" ? "btn btn-quiet" : "btn"}
                  style={{ width: "100%", marginTop: 0 }}
                  onClick={() => decide("confirm")}
                  disabled={state === "busy"}
                >
                  Confirm booking
                </button>
                <button
                  type="button"
                  className={action === "decline" ? "btn" : "btn btn-quiet"}
                  style={{ width: "100%", marginTop: 0 }}
                  onClick={() => decide("decline")}
                  disabled={state === "busy"}
                >
                  Decline booking
                </button>
              </div>
            )}
          </>
        )}
        {state === "done" && <p>{doneMessage()}</p>}
      </div>
    </div>
  );
}
