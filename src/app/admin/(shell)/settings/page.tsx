"use client";

import { useEffect, useState, type FormEvent } from "react";
import { apiGet, apiPatch, api, apiDelete, type ApiError } from "../../client";
import {
  Modal,
  Skeleton,
  EmptyState,
  useToast,
  useConfirm,
  registerPaletteAction,
} from "@/app/admin/_ui";
import { DatePicker, TimeSelect } from "@/components/ui";
import "./settings.css";

interface Settings {
  depositPercent: number; depositMinCents: number; cancellationWindowHours: number;
  currency: string; minDriverAge: number;
  turnaroundBufferHours: number; openingTime: string; closingTime: string;
  minRentalDays: number; maxRentalDays: number;
  maxAdvanceDays: number; licenseRetentionDays: number; adminAlertRecipients: string[];
  complianceAlertDays: number;
  youngDriverAge: number; youngDriverFeeCentsPerDay: number;
}
interface Blackout { id: string; startDate: string; endDate: string; reason: string }

export default function SettingsPage() {
  const [s, setS] = useState<Settings | null>(null);
  const [blackouts, setBlackouts] = useState<Blackout[]>([]);
  const [recipients, setRecipients] = useState("");
  const [loading, setLoading] = useState(true);
  const [boOpen, setBoOpen] = useState(false);
  const [bo, setBo] = useState({ startDate: "", endDate: "", reason: "" });

  const toast = useToast();
  const confirm = useConfirm();

  async function load() {
    const [settings, bl] = await Promise.all([
      apiGet<Settings>("/api/admin/settings"),
      apiGet<Blackout[]>("/api/admin/blackouts"),
    ]);
    setS(settings);
    setRecipients(settings.adminAlertRecipients.join(", "));
    setBlackouts(bl);
  }
  useEffect(() => { void load().finally(() => setLoading(false)); }, []);

  // Page-scoped command-palette action: "Add blackout date".
  useEffect(
    () =>
      registerPaletteAction({
        id: "settings-add-blackout",
        label: "Add blackout date",
        hint: "Settings",
        keywords: "blackout block date holiday close settings",
        run: () => openBlackout(),
      }),
    [],
  );

  function openBlackout() {
    setBo({ startDate: "", endDate: "", reason: "" });
    setBoOpen(true);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!s) return;
    try {
      const updated = await apiPatch<Settings>("/api/admin/settings", {
        depositPercent: s.depositPercent,
        depositMinCents: s.depositMinCents,
        cancellationWindowHours: s.cancellationWindowHours,
        currency: s.currency,
        minDriverAge: s.minDriverAge,
        turnaroundBufferHours: s.turnaroundBufferHours,
        openingTime: s.openingTime,
        closingTime: s.closingTime,
        minRentalDays: s.minRentalDays,
        maxRentalDays: s.maxRentalDays,
        maxAdvanceDays: s.maxAdvanceDays,
        licenseRetentionDays: s.licenseRetentionDays,
        complianceAlertDays: s.complianceAlertDays,
        youngDriverAge: s.youngDriverAge,
        youngDriverFeeCentsPerDay: s.youngDriverFeeCentsPerDay,
        adminAlertRecipients: recipients.split(",").map((r) => r.trim()).filter(Boolean),
      });
      setS(updated);
      toast.show({ type: "success", message: "Settings saved." });
    } catch (err) { toast.show({ type: "error", message: (err as ApiError).message }); }
  }

  async function addBlackout(e: FormEvent) {
    e.preventDefault();
    try {
      await api("/api/admin/blackouts", bo);
      setBo({ startDate: "", endDate: "", reason: "" });
      await load();
      setBoOpen(false);
      toast.show({ type: "success", message: "Blackout date added." });
    } catch (err) { toast.show({ type: "error", message: (err as ApiError).message }); }
  }

  async function removeBlackout(id: string) {
    const ok = await confirm({
      title: "Delete this blackout date?",
      message: "The dates open back up for booking across the whole fleet.",
      confirmLabel: "Delete blackout",
      danger: true,
    });
    if (!ok) return;
    try {
      await apiDelete(`/api/admin/blackouts/${id}`);
      await load();
      toast.show({ type: "success", message: "Blackout date deleted." });
    } catch (err) { toast.show({ type: "error", message: (err as ApiError).message }); }
  }

  const dollars = (c: number) => (c / 100).toString();

  return (
    <>
      <header className="set-head">
        <div className="set-head__lead">
          <h1>Settings</h1>
          <p className="sub">Fees, guardrails, and alerts. Every value here is live, no redeploy.</p>
        </div>
      </header>

      {loading || !s ? (
        <>
          <div className="panel">
            <div className="set-panel-head"><h2>Fees &amp; guardrails</h2></div>
            <div className="form-grid">
              {Array.from({ length: 16 }).map((_, i) => (
                <label key={i}><Skeleton width="55%" height={11} /><Skeleton height={38} radius={9} /></label>
              ))}
            </div>
          </div>
          <div className="panel">
            <div className="set-panel-head"><h2>Blackout dates</h2></div>
            <table className="grid" aria-busy="true">
              <thead><tr><th>From</th><th>Until</th><th>Reason</th><th></th></tr></thead>
              <tbody>
                {Array.from({ length: 3 }).map((_, r) => (
                  <tr key={r}>
                    <td><Skeleton width="60%" /></td>
                    <td><Skeleton width="60%" /></td>
                    <td><Skeleton width="80%" /></td>
                    <td><Skeleton width="50%" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <>
          <form className="panel" onSubmit={save}>
            <div className="set-panel-head">
              <div>
                <h2>Fees &amp; guardrails</h2>
                <p className="set-panel-head__hint">Rates and limits that shape what guests can book.</p>
              </div>
            </div>
            <div className="form-grid">
              <label>Deposit to reserve (% of rental total)
                <input type="number" step="1" min="0" max="100" value={s.depositPercent}
                  onChange={(e) => setS({ ...s, depositPercent: Number(e.target.value) })} />
              </label>
              <label>Minimum deposit ({s.currency})
                <input type="number" step="0.01" min="0" value={dollars(s.depositMinCents)}
                  onChange={(e) => setS({ ...s, depositMinCents: Math.round(Number(e.target.value) * 100) })} />
              </label>
              <label>Free cancellation window (hours before pickup)
                <input type="number" step="1" min="0" max="720" value={s.cancellationWindowHours}
                  onChange={(e) => setS({ ...s, cancellationWindowHours: Number(e.target.value) })} />
              </label>
              <label>Currency
                <input value={s.currency} maxLength={3}
                  onChange={(e) => setS({ ...s, currency: e.target.value.toUpperCase() })} />
              </label>
              <label>Minimum driver age
                <input type="number" min="16" max="99" value={s.minDriverAge}
                  onChange={(e) => setS({ ...s, minDriverAge: Number(e.target.value) })} />
              </label>
              <label>Young driver age threshold (under this pays the fee)
                <input type="number" min="16" max="99" value={s.youngDriverAge}
                  onChange={(e) => setS({ ...s, youngDriverAge: Number(e.target.value) })} />
              </label>
              <label>Young driver fee per day ({s.currency})
                <input type="number" step="0.01" min="0" value={dollars(s.youngDriverFeeCentsPerDay)}
                  onChange={(e) => setS({ ...s, youngDriverFeeCentsPerDay: Math.round(Number(e.target.value) * 100) })} />
              </label>
              <label>Turnaround buffer (hours)
                <input type="number" min="0" max="168" value={s.turnaroundBufferHours}
                  onChange={(e) => setS({ ...s, turnaroundBufferHours: Number(e.target.value) })} />
              </label>
              <label>Opening time
                <TimeSelect min="00:00" max="23:30" ariaLabel="Opening time" value={s.openingTime}
                  onChange={(t) => setS({ ...s, openingTime: t })} />
              </label>
              <label>Closing time
                <TimeSelect min="00:00" max="23:30" ariaLabel="Closing time" value={s.closingTime}
                  onChange={(t) => setS({ ...s, closingTime: t })} />
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
              <label>Compliance first warning (days before a document expires)
                <input type="number" min="1" max="365" value={s.complianceAlertDays}
                  onChange={(e) => setS({ ...s, complianceAlertDays: Number(e.target.value) })} />
              </label>
              <label className="full">Admin alert recipients (comma-separated emails)
                <input value={recipients} onChange={(e) => setRecipients(e.target.value)}
                  placeholder="owner@fleetdesk.app, ops@fleetdesk.app" />
              </label>
            </div>
            <div className="actions">
              <button className="btn btn--accent">Save settings</button>
            </div>
          </form>

          <div className="panel">
            <div className="set-panel-head">
              <div>
                <h2>Blackout dates</h2>
                <p className="set-panel-head__hint">Close the whole fleet for holidays, events, or downtime.</p>
              </div>
              <div className="set-panel-head__right">
                {blackouts.length > 0 && (
                  <span className="set-count">{blackouts.length} set</span>
                )}
                <button type="button" className="btn btn--quiet" onClick={openBlackout}>Add blackout</button>
              </div>
            </div>

            {blackouts.length === 0 ? (
              <EmptyState
                title="No blackout dates"
                hint="Add a date range to close booking across the whole fleet."
                action={<button type="button" className="btn btn--quiet" onClick={openBlackout}>Add blackout</button>}
              />
            ) : (
              <table className="grid">
                <thead><tr><th>From</th><th>Until</th><th>Reason</th><th></th></tr></thead>
                <tbody>
                  {blackouts.map((b) => (
                    <tr key={b.id}>
                      <td>{b.startDate}</td><td>{b.endDate}</td><td>{b.reason || "None"}</td>
                      <td className="set-actions"><div className="row-actions"><button className="danger" onClick={() => removeBlackout(b.id)}>Delete</button></div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      <Modal
        open={boOpen}
        onClose={() => setBoOpen(false)}
        title="Add blackout date"
        description="Booking is closed across the whole fleet for this range."
        size="md"
        footer={
          <>
            <button type="button" className="btn btn--quiet" onClick={() => setBoOpen(false)}>Cancel</button>
            <button type="submit" form="blackout-form" className="btn btn--accent">Add blackout</button>
          </>
        }
      >
        <form id="blackout-form" onSubmit={addBlackout}>
          <div className="form-grid">
            <label>From<DatePicker required value={bo.startDate} onChange={(iso) => setBo({ ...bo, startDate: iso })} ariaLabel="From" /></label>
            <label>Until<DatePicker required value={bo.endDate} onChange={(iso) => setBo({ ...bo, endDate: iso })} ariaLabel="Until" /></label>
            <label className="full">Reason<input value={bo.reason} onChange={(e) => setBo({ ...bo, reason: e.target.value })} placeholder="Holiday closure" /></label>
          </div>
        </form>
      </Modal>
    </>
  );
}
