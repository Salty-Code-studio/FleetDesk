"use client";

import { useEffect, useState, type FormEvent } from "react";
import { apiGet, apiPatch, api, apiDelete, type ApiError } from "../../client";
import {
  Modal,
  Skeleton,
  EmptyState,
  useToast,
  useUndo,
  registerPaletteAction,
} from "@/app/admin/_ui";
import { DatePicker, MoneyInput, TimeSelect } from "@/components/ui";
import { SetupNav } from "../setup-nav";
import "./settings.css";

// A back-office manager who may confirm/decline desk-mode bookings. The
// inviteCode links their Telegram account (t.me/<bot>?start=<code>); chatId
// is set server-side once they tap the invite link. Declared locally rather
// than imported from the db schema, matching this file's existing pattern of
// hand-shaped client interfaces (see Settings and Blackout below).
interface ApprovalManager { name: string; email?: string; inviteCode: string; chatId?: string }

interface Settings {
  depositPercent: number; depositMinCents: number; cancellationWindowHours: number;
  currency: string; minDriverAge: number;
  turnaroundBufferHours: number; openingTime: string; closingTime: string;
  minRentalDays: number; maxRentalDays: number;
  maxAdvanceDays: number; licenseRetentionDays: number; adminAlertRecipients: string[];
  complianceAlertDays: number;
  youngDriverAge: number; youngDriverFeeCentsPerDay: number;
  approvalManagers: ApprovalManager[];
  approvalReminderHours: number;
  approvalMaxReminders: number;
  // Read-only, env-derived: not part of the PATCH schema, never sent back.
  telegramBotUsername: string;
  telegramConfigured: boolean;
}
interface Blackout { id: string; startDate: string; endDate: string; reason: string }

// Field counts per labelled section below, used only to shape the loading
// skeleton so it roughly mirrors the loaded layout.
const SKELETON_SECTIONS = [3, 3, 3, 1, 3, 3, 2];

export default function SettingsPage() {
  const [s, setS] = useState<Settings | null>(null);
  const [blackouts, setBlackouts] = useState<Blackout[]>([]);
  const [recipients, setRecipients] = useState("");
  const [loading, setLoading] = useState(true);
  const [boOpen, setBoOpen] = useState(false);
  const [bo, setBo] = useState({ startDate: "", endDate: "", reason: "" });
  // Which manager's invite link was just copied, so its button can flash
  // "Copied" without a separate boolean per row (mirrors the drawer's
  // extend-link copy pattern, generalized to N rows via the invite code).
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  const toast = useToast();
  const undo = useUndo();

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

  // Booking-approval managers live on the same settings row as everything
  // else on this page, so they are edited straight on `s` (like every other
  // field here) and persisted through the one Save settings button below,
  // not a separate API call.
  function addManager() {
    if (!s) return;
    setS({
      ...s,
      approvalManagers: [...s.approvalManagers, { name: "", email: "", inviteCode: crypto.randomUUID() }],
    });
  }
  function updateManager(i: number, patch: Partial<ApprovalManager>) {
    if (!s) return;
    setS({ ...s, approvalManagers: s.approvalManagers.map((m, idx) => (idx === i ? { ...m, ...patch } : m)) });
  }
  function removeManager(i: number) {
    if (!s) return;
    setS({ ...s, approvalManagers: s.approvalManagers.filter((_, idx) => idx !== i) });
  }
  function inviteUrl(inviteCode: string): string {
    return `https://t.me/${s?.telegramBotUsername ?? ""}?start=${inviteCode}`;
  }
  async function copyInvite(inviteCode: string) {
    try {
      await navigator.clipboard.writeText(inviteUrl(inviteCode));
      setCopiedCode(inviteCode);
      setTimeout(() => setCopiedCode((c) => (c === inviteCode ? null : c)), 1500);
    } catch {
      toast.show({ type: "error", message: "Couldn't copy the link, please copy it by hand." });
    }
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
        approvalManagers: s.approvalManagers.map((m) => ({
          name: m.name,
          email: m.email && m.email.trim() ? m.email.trim() : undefined,
          inviteCode: m.inviteCode,
          chatId: m.chatId || undefined,
        })),
        approvalReminderHours: s.approvalReminderHours,
        approvalMaxReminders: s.approvalMaxReminders,
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

  async function removeBlackout(b: Blackout) {
    try {
      await apiDelete(`/api/admin/blackouts/${b.id}`);
      await load();
      undo("Blackout removed.", async () => {
        await api("/api/admin/blackouts", { startDate: b.startDate, endDate: b.endDate, reason: b.reason });
        await load();
      });
    } catch (err) { toast.show({ type: "error", message: (err as ApiError).message }); }
  }

  return (
    <>
      <SetupNav />
      <header className="set-head">
        <div className="set-head__lead">
          <h1>Settings</h1>
          <p className="sub">Fees, guardrails, and alerts. Every value here is live, no redeploy.</p>
        </div>
      </header>

      {loading || !s ? (
        <>
          <div className="panel">
            <div className="set-panel-head"><h2>Settings</h2></div>
            {SKELETON_SECTIONS.map((count, i) => (
              <div className="set-section" key={i}>
                <Skeleton width="26%" height={11} />
                <div className="form-grid">
                  {Array.from({ length: count }).map((_, j) => (
                    <label key={j}><Skeleton width="55%" height={11} /><Skeleton height={38} radius={9} /></label>
                  ))}
                </div>
              </div>
            ))}
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

            <section className="set-section">
              <div className="set-section__head">
                <h3>Business hours &amp; turnaround</h3>
                <p className="set-section__hint">When the fleet opens, and how long a car sits idle between bookings.</p>
              </div>
              <div className="form-grid">
                <label>Opening time
                  <TimeSelect min="00:00" max="23:30" ariaLabel="Opening time" value={s.openingTime}
                    onChange={(t) => setS({ ...s, openingTime: t })} />
                </label>
                <label>Closing time
                  <TimeSelect min="00:00" max="23:30" ariaLabel="Closing time" value={s.closingTime}
                    onChange={(t) => setS({ ...s, closingTime: t })} />
                </label>
                <label>Turnaround buffer (hours)
                  <input type="number" min="0" max="168" value={s.turnaroundBufferHours}
                    onChange={(e) => setS({ ...s, turnaroundBufferHours: Number(e.target.value) })} />
                </label>
              </div>
            </section>

            <section className="set-section">
              <div className="set-section__head">
                <h3>Booking window</h3>
                <p className="set-section__hint">How short, how long, and how far ahead a booking can run.</p>
              </div>
              <div className="form-grid">
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
              </div>
            </section>

            <section className="set-section">
              <div className="set-section__head">
                <h3>Pricing &amp; deposits</h3>
                <p className="set-section__hint">What guests pay to reserve, in your set currency.</p>
              </div>
              <div className="form-grid">
                <label>Deposit to reserve (% of rental total)
                  <input type="number" step="1" min="0" max="100" value={s.depositPercent}
                    onChange={(e) => setS({ ...s, depositPercent: Number(e.target.value) })} />
                </label>
                <label>Minimum deposit ({s.currency})
                  <MoneyInput cents={s.depositMinCents} ariaLabel="Minimum deposit"
                    onChange={(cents) => setS({ ...s, depositMinCents: cents })} />
                </label>
                <label>Currency
                  <input value={s.currency} maxLength={3}
                    onChange={(e) => setS({ ...s, currency: e.target.value.toUpperCase() })} />
                </label>
              </div>
            </section>

            <section className="set-section">
              <div className="set-section__head">
                <h3>Cancellation policy</h3>
                <p className="set-section__hint">How much notice guests need for a free cancellation.</p>
              </div>
              <div className="form-grid">
                <label>Free cancellation window (hours before pickup)
                  <input type="number" step="1" min="0" max="720" value={s.cancellationWindowHours}
                    onChange={(e) => setS({ ...s, cancellationWindowHours: Number(e.target.value) })} />
                </label>
              </div>
            </section>

            <section className="set-section">
              <div className="set-section__head">
                <h3>Young drivers</h3>
                <p className="set-section__hint">Minimum age to rent, plus the surcharge under the young-driver threshold.</p>
              </div>
              <div className="form-grid">
                <label>Minimum driver age
                  <input type="number" min="16" max="99" value={s.minDriverAge}
                    onChange={(e) => setS({ ...s, minDriverAge: Number(e.target.value) })} />
                </label>
                <label>Young driver age threshold (under this pays the fee)
                  <input type="number" min="16" max="99" value={s.youngDriverAge}
                    onChange={(e) => setS({ ...s, youngDriverAge: Number(e.target.value) })} />
                </label>
                <label>Young driver fee per day ({s.currency})
                  <MoneyInput cents={s.youngDriverFeeCentsPerDay} ariaLabel="Young driver fee per day"
                    onChange={(cents) => setS({ ...s, youngDriverFeeCentsPerDay: cents })} />
                </label>
              </div>
            </section>

            <section className="set-section">
              <div className="set-section__head">
                <h3>Compliance &amp; alerts</h3>
                <p className="set-section__hint">Licence retention, expiry warnings, and who gets notified.</p>
              </div>
              <div className="form-grid">
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
            </section>

            <section className="set-section">
              <div className="set-section__head">
                <h3>Booking approvals</h3>
                <p className="set-section__hint">Who gets pinged to confirm a desk-mode booking, on Telegram and by email.</p>
              </div>

              {s.approvalManagers.length === 0 ? (
                <p className="muted">No approval managers yet. Add one so desk bookings have someone to confirm them.</p>
              ) : (
                <div className="set-mgr-list">
                  {s.approvalManagers.map((m, i) => (
                    <div className="set-mgr-row" key={m.inviteCode}>
                      <div className="form-grid">
                        <label>Name
                          <input value={m.name} placeholder="For example: Maya"
                            onChange={(e) => updateManager(i, { name: e.target.value })} />
                        </label>
                        <label>Email (optional)
                          <input type="email" value={m.email ?? ""} placeholder="maya@fleetdesk.app"
                            onChange={(e) => updateManager(i, { email: e.target.value })} />
                        </label>
                        <label className="full">Telegram
                          {m.chatId ? (
                            <span className="tag on">Linked</span>
                          ) : !s.telegramConfigured ? (
                            <span className="muted">Set TELEGRAM_BOT_TOKEN to enable Telegram pings. Email still works.</span>
                          ) : (
                            <span className="set-mgr-invite">
                              <input type="text" readOnly value={inviteUrl(m.inviteCode)} onFocus={(e) => e.currentTarget.select()} />
                              <button type="button" className="btn btn--quiet" onClick={() => copyInvite(m.inviteCode)}>
                                {copiedCode === m.inviteCode ? "Copied" : "Copy"}
                              </button>
                            </span>
                          )}
                        </label>
                      </div>
                      <div className="set-mgr-row__foot row-actions">
                        <button type="button" className="danger" onClick={() => removeManager(i)}>Remove manager</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="actions">
                <button type="button" className="btn btn--quiet" onClick={addManager}>Add manager</button>
              </div>

              <div className="form-grid" style={{ marginTop: "1.3rem" }}>
                <label>Reminder interval (hours)
                  <input type="number" min="1" max="168" value={s.approvalReminderHours}
                    onChange={(e) => setS({ ...s, approvalReminderHours: Number(e.target.value) })} />
                </label>
                <label>Maximum reminders
                  <input type="number" min="0" max="10" value={s.approvalMaxReminders}
                    onChange={(e) => setS({ ...s, approvalMaxReminders: Number(e.target.value) })} />
                </label>
              </div>
            </section>

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
                      <td className="set-actions"><div className="row-actions"><button className="danger" onClick={() => removeBlackout(b)}>Delete</button></div></td>
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
