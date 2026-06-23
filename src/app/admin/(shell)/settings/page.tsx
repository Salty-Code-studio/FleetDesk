"use client";

import { useEffect, useState, type FormEvent } from "react";
import { apiGet, apiPatch, api, apiDelete, type ApiError } from "../../client";

interface Settings {
  reservationFeeCents: number; currency: string; minDriverAge: number;
  turnaroundBufferDays: number; minRentalDays: number; maxRentalDays: number;
  maxAdvanceDays: number; licenseRetentionDays: number; adminAlertRecipients: string[];
}
interface Blackout { id: string; startDate: string; endDate: string; reason: string }

export default function SettingsPage() {
  const [s, setS] = useState<Settings | null>(null);
  const [blackouts, setBlackouts] = useState<Blackout[]>([]);
  const [recipients, setRecipients] = useState("");
  const [msg, setMsg] = useState("");
  const [bo, setBo] = useState({ startDate: "", endDate: "", reason: "" });

  async function load() {
    const [settings, bl] = await Promise.all([
      apiGet<Settings>("/api/admin/settings"),
      apiGet<Blackout[]>("/api/admin/blackouts"),
    ]);
    setS(settings);
    setRecipients(settings.adminAlertRecipients.join(", "));
    setBlackouts(bl);
  }
  useEffect(() => { void load(); }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!s) return;
    setMsg("");
    try {
      const updated = await apiPatch<Settings>("/api/admin/settings", {
        reservationFeeCents: s.reservationFeeCents,
        currency: s.currency,
        minDriverAge: s.minDriverAge,
        turnaroundBufferDays: s.turnaroundBufferDays,
        minRentalDays: s.minRentalDays,
        maxRentalDays: s.maxRentalDays,
        maxAdvanceDays: s.maxAdvanceDays,
        licenseRetentionDays: s.licenseRetentionDays,
        adminAlertRecipients: recipients.split(",").map((r) => r.trim()).filter(Boolean),
      });
      setS(updated);
      setMsg("Saved.");
    } catch (err) { setMsg((err as ApiError).message); }
  }

  async function addBlackout(e: FormEvent) {
    e.preventDefault();
    setMsg("");
    try {
      await api("/api/admin/blackouts", bo);
      setBo({ startDate: "", endDate: "", reason: "" });
      await load();
    } catch (err) { setMsg((err as ApiError).message); }
  }

  async function removeBlackout(id: string) {
    await apiDelete(`/api/admin/blackouts/${id}`);
    await load();
  }

  if (!s) return <p className="muted">Loading…</p>;
  const dollars = (c: number) => (c / 100).toString();

  return (
    <>
      <h1>Settings</h1>
      <p className="sub">Fees, guardrails, and alerts. Every value here is live, no redeploy.</p>

      <form className="panel" onSubmit={save}>
        <h2>Fees &amp; guardrails</h2>
        <div className="form-grid">
          <label>Reservation fee ({s.currency})
            <input type="number" step="0.01" min="0" value={dollars(s.reservationFeeCents)}
              onChange={(e) => setS({ ...s, reservationFeeCents: Math.round(Number(e.target.value) * 100) })} />
          </label>
          <label>Currency
            <input value={s.currency} maxLength={3}
              onChange={(e) => setS({ ...s, currency: e.target.value.toUpperCase() })} />
          </label>
          <label>Minimum driver age
            <input type="number" min="16" max="99" value={s.minDriverAge}
              onChange={(e) => setS({ ...s, minDriverAge: Number(e.target.value) })} />
          </label>
          <label>Turnaround buffer (days)
            <input type="number" min="0" max="30" value={s.turnaroundBufferDays}
              onChange={(e) => setS({ ...s, turnaroundBufferDays: Number(e.target.value) })} />
          </label>
          <label>Minimum rental (days)
            <input type="number" min="1" max="365" value={s.minRentalDays}
              onChange={(e) => setS({ ...s, minRentalDays: Number(e.target.value) })} />
          </label>
          <label>Maximum rental (days)
            <input type="number" min="1" max="365" value={s.maxRentalDays}
              onChange={(e) => setS({ ...s, maxRentalDays: Number(e.target.value) })} />
          </label>
          <label>Max days ahead a booking is allowed
            <input type="number" min="1" max="1095" value={s.maxAdvanceDays}
              onChange={(e) => setS({ ...s, maxAdvanceDays: Number(e.target.value) })} />
          </label>
          <label>Licence document retention (days after return)
            <input type="number" min="1" max="3650" value={s.licenseRetentionDays}
              onChange={(e) => setS({ ...s, licenseRetentionDays: Number(e.target.value) })} />
          </label>
          <label className="full">Admin alert recipients (comma-separated emails)
            <input value={recipients} onChange={(e) => setRecipients(e.target.value)}
              placeholder="owner@fleetdesk.app, ops@fleetdesk.app" />
          </label>
        </div>
        <div className="actions">
          <button className="btn">Save settings</button>
          <span className="muted">{msg}</span>
        </div>
      </form>

      <div className="panel">
        <h2>Blackout dates</h2>
        <table className="grid">
          <thead><tr><th>From</th><th>Until</th><th>Reason</th><th></th></tr></thead>
          <tbody>
            {blackouts.length === 0 && <tr><td colSpan={4} className="muted">None set.</td></tr>}
            {blackouts.map((b) => (
              <tr key={b.id}>
                <td>{b.startDate}</td><td>{b.endDate}</td><td>{b.reason || "—"}</td>
                <td><div className="row-actions"><button className="danger" onClick={() => removeBlackout(b.id)}>Delete</button></div></td>
              </tr>
            ))}
          </tbody>
        </table>
        <form className="inline-form" style={{ marginTop: "1rem" }} onSubmit={addBlackout}>
          <label>From<br /><input type="date" required value={bo.startDate} onChange={(e) => setBo({ ...bo, startDate: e.target.value })} /></label>
          <label>Until<br /><input type="date" required value={bo.endDate} onChange={(e) => setBo({ ...bo, endDate: e.target.value })} /></label>
          <label>Reason<br /><input value={bo.reason} onChange={(e) => setBo({ ...bo, reason: e.target.value })} /></label>
          <button className="btn" style={{ width: "auto" }}>Add</button>
        </form>
      </div>
    </>
  );
}
