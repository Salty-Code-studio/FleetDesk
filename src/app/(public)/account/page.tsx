"use client";

import { useEffect, useState } from "react";

interface Booking {
  id: string; vehicleName: string; startDate: string; endDate: string; status: string;
  breakdown: { subtotalCents: number; currency: string };
}

function csrf() {
  return document.cookie.match(/(?:^|;\s*)(?:__Host-)?csrf=([^;]+)/)?.[1] ?? "";
}

const money = (c: number, cur: string) => `${cur} ${(c / 100).toFixed(2)}`;
const STATUS: Record<string, string> = { pending: "Awaiting payment", confirmed: "Confirmed", cancelled: "Cancelled", completed: "Completed" };

export default function AccountPage() {
  const [me, setMe] = useState<{ email: string } | null>(null);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    const meRes = await fetch("/api/me");
    if (!meRes.ok) { window.location.href = "/account/login"; return; }
    setMe(await meRes.json());
    setBookings(await fetch("/api/me/bookings").then((r) => r.json()));
    setLoading(false);
  }
  useEffect(() => { void load(); }, []);

  async function cancel(id: string) {
    await fetch(`/api/me/bookings/${id}/cancel`, { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf() }, body: "{}" });
    await load();
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf() }, body: "{}" });
    window.location.href = "/account/login";
  }

  if (loading) return <div className="wrap"><p className="note">Loading…</p></div>;

  return (
    <div className="wrap" style={{ maxWidth: 720 }}>
      <div className="acct-head">
        <h1>My bookings</h1>
        <button className="btn btn-quiet" onClick={logout}>Sign out</button>
      </div>
      <p className="note">{me?.email}</p>
      {bookings.length === 0 ? (
        <div className="card"><p className="note">No bookings yet. <a href="/book">Book a car</a></p></div>
      ) : bookings.map((b) => (
        <div className="card" key={b.id}>
          <div className="acct-booking">
            <div>
              <strong>{b.vehicleName}</strong><br />
              <span className="note">{b.startDate} to {b.endDate} · {money(b.breakdown.subtotalCents, b.breakdown.currency)}</span>
            </div>
            <div className="acct-status">
              <span className={`status-tag ${b.status === "confirmed" ? "ok" : b.status === "cancelled" ? "no" : "neutral"}`}>{STATUS[b.status] ?? b.status}</span>
              {(b.status === "pending" || b.status === "confirmed") && (
                <div><button className="btn btn-danger" onClick={() => cancel(b.id)}>Cancel</button></div>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
