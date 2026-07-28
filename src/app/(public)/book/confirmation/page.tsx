"use client";

import { useEffect, useState } from "react";
import { formatDateTime } from "@/lib/time/format";
import { siteConfig } from "@/lib/site-config";

interface Booking {
  id: string;
  status: string;
  startAt: string;
  endAt: string;
  amountPaidCents?: number;
  priceBreakdown?: { currency?: string } | null;
}

// Same key book/page.tsx persists the in-progress wizard draft under
// (WIZARD_STORAGE_KEY there, not exported). This page is where a booking is
// done cooking, so it retires that draft on mount.
const WIZARD_STORAGE_KEY = "book-wizard-v1";

// The webhook that flips a booking to "confirmed" can land well after the
// Stripe redirect. Rather than give up after a few seconds, poll with
// backoff: 4 quick pings, then 6 a bit slower, then 7 patient ones
// (~59.5s total) before handing control to the "Check again" button.
const BACKOFF_MS = [
  ...Array(4).fill(1500),
  ...Array(6).fill(3000),
  ...Array(7).fill(5000),
];

const money = (cents: number, currency = "USD") =>
  currency === "USD" ? `$${(cents / 100).toFixed(2)}` : `${currency} ${(cents / 100).toFixed(2)}`;

export default function ConfirmationPage() {
  const [booking, setBooking] = useState<Booking | null>(null);
  const [loading, setLoading] = useState(true);
  const [polling, setPolling] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    // The wizard's persisted draft has done its job by the time this page
    // mounts (the booking exists, paid or not) — clear it so a later /book
    // visit never resurrects a stale, already-placed booking.
    try { window.sessionStorage.removeItem(WIZARD_STORAGE_KEY); } catch { /* storage unavailable — nothing to clear */ }

    const id = new URLSearchParams(window.location.search).get("id");
    if (!id) { setLoading(false); return; }

    let cancelled = false;
    let tries = 0;

    const poll = () => {
      fetch(`/api/bookings/${id}`).then((r) => (r.ok ? r.json() : null)).then((b: Booking | null) => {
        if (cancelled) return;
        setBooking(b);
        setLoading(false);
        if (b && b.status === "pending" && tries < BACKOFF_MS.length) {
          setPolling(true);
          const delay = BACKOFF_MS[tries] ?? 5000;
          tries++;
          setTimeout(poll, delay);
        } else {
          setPolling(false);
          // Ran out of patience while still pending: hand off to "Check again".
          if (b && b.status === "pending") setExhausted(true);
        }
      }).catch(() => {
        if (cancelled) return;
        setLoading(false);
        setPolling(false);
        setExhausted(true);
      });
    };
    poll();
    return () => { cancelled = true; };
  }, []);

  function checkAgain() {
    const id = new URLSearchParams(window.location.search).get("id");
    if (!id || checking) return;
    setChecking(true);
    fetch(`/api/bookings/${id}`).then((r) => (r.ok ? r.json() : null)).then((b: Booking | null) => {
      if (b) setBooking(b);
    }).catch(() => { /* stay on the exhausted state; the customer can try again */ }).finally(() => setChecking(false));
  }

  const confirmed = booking?.status === "confirmed";

  return (
    <div className="wrap confirm">
      <div className="card">
        <div className="big" aria-hidden="true">{confirmed ? "✅" : "🚗"}</div>
        <h1>{confirmed ? "Booking confirmed" : "Your car is reserved"}</h1>
        {loading ? (
          <p className="note">Checking your booking…</p>
        ) : !booking ? (
          <p>We&apos;ve received your request. Our team will be in touch shortly.</p>
        ) : confirmed ? (
          <>
            <p>Payment received and your booking for {formatDateTime(booking.startAt)} to {formatDateTime(booking.endAt)} is confirmed.
              We&apos;ll arrange delivery on WhatsApp. See you soon.</p>
            {typeof booking.amountPaidCents === "number" && booking.amountPaidCents > 0 && (
              <p className="note">Payment received: {money(booking.amountPaidCents, booking.priceBreakdown?.currency)}</p>
            )}
          </>
        ) : (
          <>
            <p>Your booking for {formatDateTime(booking.startAt)} to {formatDateTime(booking.endAt)} is held. If you just paid, the
              confirmation lands in a moment. Our team will also reach out on WhatsApp.</p>
            {polling ? (
              <p className="note">Checking your payment…</p>
            ) : exhausted ? (
              <div style={{ marginTop: "1rem" }}>
                <button type="button" className="btn" onClick={checkAgain} disabled={checking}>
                  {checking ? "Checking…" : "Check again"}
                </button>
                {siteConfig.whatsappHref && (
                  <p className="note">
                    <a href={siteConfig.whatsappHref} target="_blank" rel="noreferrer">Questions? Message us on WhatsApp</a>
                  </p>
                )}
              </div>
            ) : null}
          </>
        )}
        <p style={{ marginTop: "1.75rem" }}><a href="https://fleetdesk.app">Back to fleetdesk.app</a></p>
      </div>
    </div>
  );
}
