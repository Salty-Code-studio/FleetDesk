"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { DatePicker, TimeSelect } from "@/components/ui";
import { paymentAmounts, depositSettingsFromSnapshot } from "@/lib/payments/amounts";
import { SCREENS, validateScreen, screenFromStored, type Screen } from "@/lib/booking/funnel";

interface ClassOption { class: string; fromDayCents: number; depositCents: number | null; cars: number; available: boolean | null; carSlug: string | null; photo: string | null }
interface Tier { id: string; name: string; dailyPriceCents: number; coverage: string; isDefault: boolean }
interface AddOn { id: string; name: string; description: string; priceCents: number; pricing: "per_day" | "per_rental" }
interface Breakdown {
  days: number; vehicleCents: number; insuranceCents: number;
  addOns: { id: string; name: string; qty: number; cents: number }[];
  addOnsCents: number; subtotalCents: number; depositCents: number | null; depositPercent: number; depositMinCents: number; youngDriverCents: number; youngDriver: boolean; currency: string;
  // /api/quote always sends this now (Task 11): the cancellation window and the
  // vehicle's refundable at-pickup security deposit, sourced from the same
  // settings + vehicle rows the price itself was computed from.
  policy: { cancellationWindowHours: number; securityDepositCents: number | null };
}
interface BookingConfig {
  minDriverAge: number; youngDriverAge: number; youngDriverFeeCentsPerDay: number;
  // The operator's actual pick-up/return window ("HH:MM") — seeds the Dates
  // step's TimeSelect min/max so an out-of-hours slot is never offered.
  openingTime: string; closingTime: string;
  // "desk" = no online payment; the wizard skips Stripe checkout entirely and
  // shows pay-at-pickup copy instead.
  paymentMode: "online" | "desk";
}

const money = (c: number, cur = "USD") => (cur === "USD" ? `$${(c / 100).toFixed(2)}` : `${cur} ${(c / 100).toFixed(2)}`);
// Local "today" as ISO yyyy-mm-dd, used only as a min bound on the date pickers.
const todayISO = () => { const d = new Date(); const p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

// Three screens (Flow Desk phase 4). The licence is no longer asked here: the
// desk captures it at check-in, where the age gate runs.
const TOTAL = SCREENS.length;

// ---------------------------------------------------------------------------
// Wizard state persistence: everything the customer has entered survives a
// refresh or an accidental tab close, keyed under one sessionStorage entry so
// a resumed session (or a "back out of Stripe, come back" round trip) doesn't
// force them to redo the whole form. Cleared once a checkout redirect begins
// or (Task 12) when the confirmation page mounts.
// ---------------------------------------------------------------------------
const WIZARD_STORAGE_KEY = "book-wizard-v1";

interface WizardStorage {
  // 2 = the three-screen funnel. Absent = a state saved by the old seven-step
  // wizard; screenFromStored maps its step onto the new screens.
  v?: number;
  step?: number;
  selectedClass?: string;
  pickup?: string; ret?: string; pickupTime?: string; retTime?: string;
  tierId?: string;
  qty?: Record<string, number>;
  customer?: { name: string; email: string; phone: string };
  paymentOption?: "deposit" | "full";
  acceptTerms?: boolean;
  driverAge?: "" | "under" | "young" | "standard";
}

function readWizardStorage(): WizardStorage {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.sessionStorage.getItem(WIZARD_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as WizardStorage) : {};
  } catch { return {}; }
}

function clearWizardStorage(): void {
  try { window.sessionStorage.removeItem(WIZARD_STORAGE_KEY); } catch { /* storage unavailable — nothing to clear */ }
}

export default function BookPage() {
  // This page is server-rendered, so the FIRST client render must produce the
  // exact same markup as the server (which has no sessionStorage) or React's
  // hydration fails. Every field below therefore starts at its plain default;
  // any persisted wizard state is applied in a mount-only effect further down,
  // AFTER hydration, via the setters. `restoredRef` holds the raw parse so a
  // later effect (the insurance-tier default) can check "was this restored?"
  // without racing a stale closure.
  const restoredRef = useRef<WizardStorage>({});

  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [addons, setAddons] = useState<AddOn[]>([]);
  const [selectedClass, setSelectedClass] = useState("");
  const [pickup, setPickup] = useState("");
  const [ret, setRet] = useState("");
  const [pickupTime, setPickupTime] = useState("");
  const [retTime, setRetTime] = useState("");
  // Safe pre-load default only, for the first paint before /api/booking-config
  // resolves; the mount effect below overwrites this with the operator's real
  // hours so the TimeSelect controls never offer an out-of-hours slot.
  const [hours, setHours] = useState<{ openingTime: string; closingTime: string }>({ openingTime: "08:00", closingTime: "18:00" });
  // Same pre-load-default-then-correct pattern as hours above: "online" until
  // the booking-config fetch below resolves, so a normal online deployment's
  // first paint never differs from before this field existed.
  const [paymentMode, setPaymentMode] = useState<"online" | "desk">("online");
  const [tierId, setTierId] = useState<string>("");
  const [qty, setQty] = useState<Record<string, number>>({});
  const [customer, setCustomer] = useState({ name: "", email: "", phone: "" });
  const [paymentOption, setPaymentOption] = useState<"deposit" | "full">("deposit");
  const [acceptTerms, setAcceptTerms] = useState(false);
  // wave-05: booking-config knobs (age band labels + fee) and the claimed age
  // band. It prices the booking; the desk checks the licence at pick-up.
  const [cfg, setCfg] = useState({ minDriverAge: 18, youngDriverAge: 21, youngDriverFeeCentsPerDay: 0 });
  const [driverAge, setDriverAge] = useState<"" | "under" | "young" | "standard">("");
  const [breakdown, setBreakdown] = useState<Breakdown | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const idemKey = useMemo(() => (typeof crypto !== "undefined" ? crypto.randomUUID() : String(Math.random())), []);

  // ---- Resume-after-cancel banner: ?canceled=1&id=<bookingId> ----
  const [canceledId, setCanceledId] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState("");

  useEffect(() => {
    // Only an online booking ever comes back with ?canceled=1 (Stripe's own
    // cancel_url); desk mode never opens a Stripe session, so there is
    // nothing to resume. Also CLEAR any id picked up during the pre-config
    // paint (the mode starts as "online" until booking-config resolves), so
    // that startup race can never leave a stale resume banner behind.
    if (paymentMode === "desk") { setCanceledId(null); return; }
    const p = new URLSearchParams(window.location.search);
    const id = p.get("id");
    if (p.get("canceled") === "1" && id) setCanceledId(id);
  }, [paymentMode]);

  async function resumePayment() {
    if (!canceledId) return;
    setResuming(true); setResumeError("");
    try {
      const res = await fetch(`/api/bookings/${canceledId}/checkout`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      const data = await res.json();
      if (res.ok && data.url) { clearWizardStorage(); window.location.href = data.url; return; }
      setResumeError(data?.error?.message ?? "We could not resume your payment. Please start over.");
    } catch {
      setResumeError("Network error. Please try again.");
    }
    setResuming(false);
  }

  function startOver() {
    clearWizardStorage();
    window.location.href = "/book";
  }

  // Full Aruba-offset timestamps once both a date and a time are chosen; falls
  // back to the bare date otherwise (the API still accepts date-only values).
  const startAt = pickup && pickupTime ? `${pickup}T${pickupTime}:00-04:00` : pickup; // date-only still accepted by the API
  const endAt = ret && retTime ? `${ret}T${retTime}:00-04:00` : ret;

  // Load catalogs + read the Phase 1 deep-link params (?class, ?pickup, ?return).
  useEffect(() => {
    Promise.all([
      fetch("/api/classes").then((r) => r.json()),
      fetch("/api/insurance").then((r) => r.json()),
      fetch("/api/addons").then((r) => r.json()),
    ]).then(([c, i, a]: [ClassOption[], Tier[], AddOn[]]) => {
      setClasses(c); setTiers(i); setAddons(a);
      const def = i.find((t) => t.isDefault);
      // Don't clobber a restored choice with the default tier.
      if (def && !restoredRef.current.tierId) setTierId(def.id);
      const p = new URLSearchParams(window.location.search);
      if (p.get("pickup")) { setPickup(p.get("pickup")!); setPickupTime(hours.openingTime); }
      if (p.get("return")) { setRet(p.get("return")!); setRetTime(hours.openingTime); }
      const cls = p.get("class") || p.get("car"); // car is legacy; both resolve to a type
      if (cls) { const m = c.find((x) => x.class.toLowerCase() === cls.toLowerCase()); if (m) setSelectedClass(m.class); }
    }).catch(() => setError("Could not load the fleet. Please refresh."));

    // Independent of the Promise.all above: a config hiccup must never block
    // the fleet from loading, so this fetch is not part of that tuple. This is
    // also the wizard's ONE source of truth for the operator's real business
    // hours: seed `hours` from it so the Dates step's TimeSelect controls (and
    // the ?pickup/?return deep-link defaults above) never offer a slot outside
    // it, which the quote would otherwise reject with a 4xx.
    fetch("/api/booking-config")
      .then((r) => (r.ok ? r.json() : null))
      .then((c: BookingConfig | null) => {
        if (!c) return;
        setCfg(c);
        setHours({ openingTime: c.openingTime, closingTime: c.closingTime });
        // Guarded like the confirmation page's consumer: an older server
        // response without the field must not clobber the "online" default
        // with undefined.
        if (c.paymentMode) setPaymentMode(c.paymentMode);
      })
      .catch(() => {});
    // Mount-only: intentionally reads the `hours` default in effect at load time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-resolve availability + the held car whenever the dates or times change.
  useEffect(() => {
    if (!pickup || !ret || ret <= pickup) return;
    let live = true;
    fetch(`/api/classes?pickup=${encodeURIComponent(startAt)}&return=${encodeURIComponent(endAt)}`)
      .then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => null) }))
      .then(({ ok, data }) => {
        if (!live) return;
        if (ok) { setClasses(data as ClassOption[]); setError(""); }
        else setError(data?.error?.message ?? "Could not check availability for those dates.");
      })
      .catch(() => {});
    return () => { live = false; };
  }, [pickup, ret, startAt, endAt]);

  const selectedData = classes.find((c) => c.class === selectedClass);
  const carSlug = selectedData?.carSlug ?? null;
  const avail = !pickup || !ret || ret <= pickup ? null
    : selectedData?.available ? { available: true as const }
    : { available: false as const, reason: "No cars of this type are free on those dates" };

  const addOnsBody = useMemo(
    () => Object.entries(qty).filter(([, q]) => q > 0).map(([addOnId, q]) => ({ addOnId, qty: q })),
    [qty],
  );

  // Live USD quote whenever the (resolved) car, dates, times, insurance or extras change.
  useEffect(() => {
    if (!carSlug || !pickup || !ret || ret <= pickup) { setBreakdown(null); return; }
    const body = { vehicleSlug: carSlug, startAt, endAt, insuranceTierId: tierId || null, addOns: addOnsBody, youngDriver: driverAge === "young" };
    let live = true;
    fetch("/api/quote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => null) }))
      .then(({ ok, data }) => {
        if (!live) return;
        if (ok) { setBreakdown(data as Breakdown); setError(""); }
        else { setBreakdown(null); setError(data?.error?.message ?? "We could not calculate your price for those dates."); }
      })
      .catch(() => {});
    return () => { live = false; };
  }, [carSlug, pickup, ret, startAt, endAt, tierId, addOnsBody, driverAge]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    // Enter in a field on an earlier screen submits the form: treat it as
    // Continue, never as a booking.
    if (step < TOTAL) { goNext(); return; }
    // A restored session can land here with an earlier screen incomplete:
    // check every screen and send the customer to the first gap.
    for (const n of [1, 2, 3] as Screen[]) {
      const problem = validateStep(n);
      if (problem) {
        if (n !== step) { setDir("back"); setStep(n); }
        setStepError(problem);
        return;
      }
    }
    setError(""); setBusy(true);
    try {
      if (!carSlug) { setError("Please pick a car type and dates."); setBusy(false); return; }
      const res = await fetch("/api/bookings", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vehicleSlug: carSlug, startAt, endAt, customer,
          insuranceTierId: tierId || null, addOns: addOnsBody,
          acceptTerms,
          // Desk mode never charges online, so there is no deposit-vs-full
          // choice to make: always send "full", since the whole balance is
          // due at pickup either way.
          paymentOption: paymentMode === "desk" ? "full" : paymentOption,
          idempotencyKey: idemKey,
          // The claimed age band prices the booking; check-in verifies it.
          youngDriver: driverAge === "young",
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data?.error?.message ?? "We could not create your booking."); setBusy(false); return; }
      if (paymentMode === "desk") {
        // No checkout to start: the booking already landed pending, and the
        // desk (or a chat approval) confirms it later.
        clearWizardStorage();
        window.location.href = `/book/confirmation?id=${data.id}`;
        return;
      }
      const checkout = await fetch(`/api/bookings/${data.id}/checkout`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      const co = await checkout.json();
      if (checkout.ok && co.url) { clearWizardStorage(); window.location.href = co.url; return; }
      clearWizardStorage();
      window.location.href = `/book/confirmation?id=${data.id}`;
    } catch { setError("Network error. Please try again."); setBusy(false); }
  }

  const cur = breakdown?.currency ?? "USD";

  // The two payment choices, computed ONLY from the server-computed breakdown
  // (MONEY-TRUTH: this is the exact number the "You pay now" line and the
  // Stripe charge both derive from — never a client-guessed amount).
  const amounts = breakdown ? {
    deposit: paymentAmounts(breakdown, "deposit", depositSettingsFromSnapshot(breakdown)),
    full: paymentAmounts(breakdown, "full", depositSettingsFromSnapshot(breakdown)),
  } : null;
  const policy = breakdown?.policy ?? null;

  // ---------------------------------------------------------------------------
  // WIZARD: navigation, validation, direction-aware transitions, a11y focus.
  // None of the booking logic above changes; this only governs which step shows.
  // ---------------------------------------------------------------------------
  const [step, setStep] = useState<Screen>(1);
  const [dir, setDir] = useState<"fwd" | "back">("fwd");
  const [stepError, setStepError] = useState(""); // per-step inline validation message
  const headingRef = useRef<HTMLHeadingElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const firstRender = useRef(true);

  // Restore any persisted wizard state — mount-only, AFTER hydration, so the
  // very first client render still matches the server-rendered (default)
  // markup. A ref keeps the raw parse around for the tier-default guard above,
  // which runs later (once the tiers fetch resolves) and must not race a stale
  // closure over plain state.
  useEffect(() => {
    const stored = readWizardStorage();
    restoredRef.current = stored;
    if (stored.selectedClass !== undefined) setSelectedClass(stored.selectedClass);
    if (stored.pickup !== undefined) setPickup(stored.pickup);
    if (stored.ret !== undefined) setRet(stored.ret);
    if (stored.pickupTime !== undefined) setPickupTime(stored.pickupTime);
    if (stored.retTime !== undefined) setRetTime(stored.retTime);
    if (stored.tierId !== undefined) setTierId(stored.tierId);
    if (stored.qty !== undefined) setQty(stored.qty);
    if (stored.customer !== undefined) setCustomer(stored.customer);
    if (stored.paymentOption !== undefined) setPaymentOption(stored.paymentOption);
    if (stored.acceptTerms !== undefined) setAcceptTerms(stored.acceptTerms);
    if (stored.driverAge !== undefined) setDriverAge(stored.driverAge);
    setStep(screenFromStored(stored));
  }, []);

  // Persist the whole wizard so far (all step fields incl. licence + times) on
  // every change. Restored above (mount-only effect); cleared once a checkout
  // redirect begins (or, Task 12, when confirmation mounts).
  useEffect(() => {
    try {
      const data: WizardStorage = {
        v: 2, step, selectedClass, pickup, ret, pickupTime, retTime, tierId, qty, customer, paymentOption, acceptTerms, driverAge,
      };
      window.sessionStorage.setItem(WIZARD_STORAGE_KEY, JSON.stringify(data));
    } catch { /* storage unavailable (private mode, quota) — degrade to no persistence */ }
  }, [step, selectedClass, pickup, ret, pickupTime, retTime, tierId, qty, customer, paymentOption, acceptTerms, driverAge]);

  // On step change, move focus to the new step heading (skip the very first paint).
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    headingRef.current?.focus();
  }, [step]);

  // Validate the current screen (rules live in lib/booking/funnel.ts). Returns
  // "" when valid, else a message, and focuses the offending field so keyboard
  // users land in the right place.
  function validateStep(n: Screen): string {
    const problem = validateScreen(n, {
      selectedClass, pickup, ret, pickupTime, retTime, driverAge, customer, acceptTerms, minDriverAge: cfg.minDriverAge,
      available: avail ? avail.available : null,
    });
    if (!problem) return "";
    if (problem.field) focusField(problem.field);
    return problem.message;
  }

  function focusField(selector: string) {
    requestAnimationFrame(() => {
      const el = panelRef.current?.querySelector<HTMLElement>(selector);
      el?.focus();
    });
  }

  function goNext() {
    const msg = validateStep(step);
    if (msg) { setStepError(msg); return; }
    setStepError("");
    setDir("fwd");
    setStep((s) => Math.min(TOTAL, s + 1) as Screen);
  }
  function goBack() {
    setStepError("");
    setDir("back");
    setStep((s) => Math.max(1, s - 1) as Screen);
  }
  // Stepper jump: only completed (earlier) steps are reachable.
  function jumpTo(n: Screen) {
    if (n >= step) return;
    setStepError("");
    setDir("back");
    setStep(n);
  }

  // The reserve button on the final step is gated exactly as before, plus a
  // driver-age check: a mid-wizard refresh restores every other field from
  // WizardStorage, so this guards the (now also persisted) age claim too in
  // case it's ever missing, rather than silently letting the button stay
  // enabled with an unset / reset claim.
  const canReserve = !busy && acceptTerms && !!avail?.available && !!driverAge && driverAge !== "under";

  return (
    <div className="wrap book-grid">
      <div>
        {/* ---------- resume-after-cancel banner ---------- */}
        {canceledId && (
          <div className="cancel-banner" role="status">
            <p>Payment canceled. Your car is still held for about 30 minutes.</p>
            <div className="actions">
              <button type="button" className="btn" onClick={resumePayment} disabled={resuming}>
                {resuming ? "Resuming…" : "Resume payment"}
              </button>
              <a href="/book" onClick={(e) => { e.preventDefault(); startOver(); }}>Start over</a>
            </div>
            {resumeError && <p className="msg err">{resumeError}</p>}
          </div>
        )}

        {/* ---------- progress stepper ---------- */}
        <nav className="stepper" aria-label="Booking progress">
          <ol className="stepper-list">
            {SCREENS.map((label, i) => {
              const n = (i + 1) as Screen;
              const state = n < step ? "done" : n === step ? "current" : "todo";
              const clickable = n < step;
              return (
                <li key={label} className={`stepper-item ${state}`}>
                  <button
                    type="button"
                    className="stepper-btn"
                    aria-current={state === "current" ? "step" : undefined}
                    disabled={!clickable}
                    onClick={() => jumpTo(n)}
                  >
                    <span className="stepper-dot" aria-hidden="true">
                      {state === "done" ? "✓" : ""}
                    </span>
                    <span className="stepper-label">{label}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        {/* announce the active step to screen readers */}
        <p className="sr-only" aria-live="polite">{SCREENS[step - 1]}</p>

        <form onSubmit={submit}>
          <div
            ref={panelRef}
            className={`wiz-panel ${dir === "fwd" ? "from-right" : "from-left"}`}
            key={step}
          >
            {/* ---- When and what: dates, times, age band, class, live price ---- */}
            {step === 1 && (
              <div className="card">
                <h2 ref={headingRef} tabIndex={-1}>When and what</h2>
                <div className="two">
                  <label className="fld">Pick-up date<DatePicker id="pickup" name="pickup" required min={todayISO()} value={pickup} onChange={(iso) => { setPickup(iso); setStepError(""); }} ariaLabel="Pick-up date" /></label>
                  <label className="fld">Pick-up time<TimeSelect id="pickup-time" ariaLabel="Pick-up time" min={hours.openingTime} max={hours.closingTime} value={pickupTime} onChange={(t) => { setPickupTime(t); setStepError(""); }} /></label>
                </div>
                <div className="two">
                  <label className="fld">Return date<DatePicker id="ret" name="ret" required min={pickup || todayISO()} value={ret} onChange={(iso) => { setRet(iso); setStepError(""); }} ariaLabel="Return date" /></label>
                  <label className="fld">Return time<TimeSelect id="ret-time" ariaLabel="Return time" min={hours.openingTime} max={hours.closingTime} value={retTime} onChange={(t) => { setRetTime(t); setStepError(""); }} /></label>
                </div>
                <div className="age-band" role="radiogroup" aria-label="Main driver's age">
                  <p className="note" style={{ marginBottom: 6 }}>Main driver&apos;s age</p>
                  <label className="opt">
                    <input type="radio" name="driver-age" checked={driverAge === "young"}
                      onChange={() => { setDriverAge("young"); setStepError(""); }} />
                    <span className="grow">Age {cfg.minDriverAge} to {cfg.youngDriverAge - 1}</span>
                    {cfg.youngDriverFeeCentsPerDay > 0 && (
                      <span className="price">{money(cfg.youngDriverFeeCentsPerDay, cur)}/day</span>
                    )}
                  </label>
                  <label className="opt">
                    <input type="radio" name="driver-age" checked={driverAge === "standard"}
                      onChange={() => { setDriverAge("standard"); setStepError(""); }} />
                    <span className="grow">Age {cfg.youngDriverAge} or older</span>
                  </label>
                  <label className="opt">
                    <input type="radio" name="driver-age" checked={driverAge === "under"}
                      onChange={() => { setDriverAge("under"); setStepError(""); }} />
                    <span className="grow">Under {cfg.minDriverAge}</span>
                  </label>
                  {driverAge === "under"
                    ? <p className="note" role="alert">Sorry, the main driver must be {cfg.minDriverAge} or older. Another driver who is old enough can book instead.</p>
                    : <p className="note">The main driver must be {cfg.minDriverAge} or older. We check the licence at pick-up.</p>}
                </div>

                <div className="hero-list" role="radiogroup" aria-label="Car type">
                  {classes.length === 0 && <p className="note">Loading the fleet…</p>}
                  {classes.map((c) => (
                    <button type="button" key={c.class} role="radio" aria-checked={c.class === selectedClass}
                      className={`hero${c.class === selectedClass ? " sel" : ""}`}
                      disabled={c.available === false}
                      onClick={() => { setSelectedClass(c.class); setStepError(""); }}>
                      <span className="hero__back" aria-hidden="true">{c.class}</span>
                      {c.photo && (
                        <span className="hero__car" aria-hidden="true"
                          style={{ backgroundImage: `url("${c.photo.replace(/"/g, "%22")}")` }} />
                      )}
                      <span className="hero__mid">
                        <span className="nm">{c.class}</span>
                        <span className="meta">
                          {c.available === false ? "None free on those dates" : `${c.cars} car${c.cars !== 1 ? "s" : ""} in this class`}
                        </span>
                      </span>
                      <span className="price"><b>{money(c.fromDayCents, "USD")}</b><span className="meta">a day</span></span>
                    </button>
                  ))}
                </div>
                {selectedClass && breakdown && (
                  <p className="hero-total" aria-live="polite">
                    <b>{money(breakdown.subtotalCents, cur)}</b> for {breakdown.days} day{breakdown.days !== 1 ? "s" : ""}
                  </p>
                )}
                {selectedClass && avail && !avail.available && <p className="avail no">✕ {avail.reason}</p>}
              </div>
            )}

            {/* ---- Protect and add: insurance tier and extras ---- */}
            {step === 2 && (
              <div className="card">
                <h2 ref={headingRef} tabIndex={-1}>Protect and add</h2>
                <h3 className="sub-h">Insurance</h3>
                {tiers.map((t) => (
                  <label className="opt" key={t.id}>
                    <input type="radio" name="tier" checked={tierId === t.id} onChange={() => setTierId(t.id)} />
                    <span className="grow"><b>{t.name}</b>{t.coverage ? <><br /><span className="meta">{t.coverage}</span></> : null}</span>
                    <span className="price">{t.dailyPriceCents === 0 ? "included" : `${money(t.dailyPriceCents, cur)}/day`}</span>
                  </label>
                ))}
                <h3 className="sub-h">Extras</h3>
                {addons.length === 0 && <p className="note">No extras available for this booking.</p>}
                {addons.map((a) => (
                  <label className="opt" key={a.id}>
                    <input type="checkbox" checked={(qty[a.id] ?? 0) > 0} onChange={(e) => setQty((q) => ({ ...q, [a.id]: e.target.checked ? 1 : 0 }))} />
                    <span className="grow"><b>{a.name}</b>{a.description ? <><br /><span className="meta">{a.description}</span></> : null}</span>
                    {(qty[a.id] ?? 0) > 0 && (
                      <input type="number" min={1} max={10} value={qty[a.id]} style={{ width: 56 }}
                        onChange={(e) => setQty((q) => ({ ...q, [a.id]: Math.min(10, Math.max(1, Number(e.target.value) || 1)) }))} />
                    )}
                    <span className="price">{money(a.priceCents, cur)}{a.pricing === "per_day" ? "/day" : ""}</span>
                  </label>
                ))}
              </div>
            )}

            {/* ---- You and pay: details, payment choice, terms ---- */}
            {step === 3 && (
              <div className="card">
                <h2 ref={headingRef} tabIndex={-1}>You and pay</h2>
                <div className="two">
                  <label className="fld">Full name<input id="cust-name" required value={customer.name} onChange={(e) => { setCustomer({ ...customer, name: e.target.value }); setStepError(""); }} /></label>
                  <label className="fld">Email<input id="cust-email" type="email" required value={customer.email} onChange={(e) => { setCustomer({ ...customer, email: e.target.value }); setStepError(""); }} /></label>
                  <label className="fld">Phone<input id="cust-phone" required value={customer.phone} onChange={(e) => { setCustomer({ ...customer, phone: e.target.value }); setStepError(""); }} /></label>
                </div>
                <p className="note">Bring your driver&apos;s licence when you pick up the car. We check it at the desk.</p>

                <dl className="recap">
                  <div className="recap-row"><dt>Car type</dt><dd>{selectedClass || "Not chosen yet"}</dd></div>
                  <div className="recap-row"><dt>Dates</dt><dd>{pickup && ret ? `Pick-up ${pickup} at ${pickupTime} to Return ${ret} at ${retTime}` : "Not set"}{breakdown ? ` · ${breakdown.days} day${breakdown.days !== 1 ? "s" : ""}` : ""}</dd></div>
                  <div className="recap-row"><dt>Insurance</dt><dd>{tiers.find((t) => t.id === tierId)?.name ?? "Basic"}</dd></div>
                  <div className="recap-row"><dt>Extras</dt><dd>{addOnsBody.length === 0 ? "None" : addons.filter((a) => (qty[a.id] ?? 0) > 0).map((a) => `${a.name}${(qty[a.id] ?? 0) > 1 ? ` ×${qty[a.id]}` : ""}`).join(", ")}</dd></div>
                  <div className="recap-row"><dt>Driver age</dt><dd>{driverAge === "young" ? `${cfg.minDriverAge} to ${cfg.youngDriverAge - 1}` : driverAge === "standard" ? `${cfg.youngDriverAge} or older` : "Not set"}</dd></div>
                  {breakdown && <div className="recap-row total"><dt>Rental total</dt><dd>{money(breakdown.subtotalCents, cur)}</dd></div>}
                </dl>

                {breakdown && amounts && (
                  <>
                    {paymentMode !== "desk" && (
                      <div className="pay-options" role="radiogroup" aria-label="How would you like to pay?">
                        <button type="button" className={`pay-card${paymentOption === "deposit" ? " selected" : ""}`} onClick={() => setPaymentOption("deposit")}>
                          <span className="pay-card-title">Reserve with a deposit</span>
                          <span className="pay-card-now">Pay {money(amounts.deposit.payNowCents, cur)} now</span>
                          <span className="pay-card-later">{money(amounts.deposit.balanceDueCents, cur)} at pickup</span>
                        </button>
                        <button type="button" className={`pay-card${paymentOption === "full" ? " selected" : ""}`} onClick={() => setPaymentOption("full")}>
                          <span className="pay-card-title">Pay in full</span>
                          <span className="pay-card-now">Pay {money(amounts.full.payNowCents, cur)} now</span>
                          <span className="pay-card-later">Nothing due at pickup</span>
                        </button>
                      </div>
                    )}

                    {policy && (
                      <div className="policy-box">
                        <p>Free cancellation until {policy.cancellationWindowHours} hours before pickup.</p>
                        {/* Desk mode collects nothing online, so there is no
                            paid deposit to withhold; the sentence would be
                            false there and is omitted entirely. */}
                        {paymentMode !== "desk" && (
                          <p>Within {policy.cancellationWindowHours} hours or no show: the deposit is not refunded.</p>
                        )}
                        {policy.securityDepositCents !== null && (
                          <p>Refundable security deposit of {money(policy.securityDepositCents, cur)} due at pickup. You get it back at return.</p>
                        )}
                      </div>
                    )}

                    {paymentMode !== "desk" && (
                      <div className="trust-row">
                        <span className="trust-lock" aria-hidden>🔒</span>
                        <span>Secure payment via Stripe. You will be redirected to Stripe and back.</span>
                      </div>
                    )}

                    <p className="pay-now-line">
                      {paymentMode === "desk" ? "Due at pickup: " : "You pay now: "}
                      <strong>{money(paymentMode === "desk" ? amounts.full.payNowCents : amounts[paymentOption].payNowCents, cur)}</strong>
                    </p>
                  </>
                )}

                <label className="terms" style={{ margin: "1rem 0" }}>
                  <input id="accept-terms" type="checkbox" checked={acceptTerms} onChange={(e) => { setAcceptTerms(e.target.checked); setStepError(""); }} />
                  <span>I accept the <a href="/policies/rental_terms" target="_blank" rel="noreferrer">rental terms</a>, <a href="/policies/cancellation" target="_blank" rel="noreferrer">cancellation policy</a>, and <a href="/policies/privacy" target="_blank" rel="noreferrer">privacy policy</a>.</span>
                </label>

                {selectedClass && avail && !avail.available && <p className="avail no">✕ {avail.reason}</p>}
              </div>
            )}
          </div>

          {/* per-step inline validation, announced politely */}
          <p className="msg err wiz-error" role="alert" aria-live="assertive">{stepError}</p>

          {/* catalog/quote errors (e.g. a 4xx from /api/quote or /api/classes) —
              rendered on every step, not just the last, since a bad quote can
              surface as early as the Dates step. */}
          {error && <p className="msg err" role="alert" aria-live="assertive">{error}</p>}

          {/* ---------- navigation ---------- */}
          <div className="wiz-nav">
            {step > 1
              ? <button type="button" className="btn btn-quiet wiz-back" onClick={goBack}>Back</button>
              : <span />}
            {step < TOTAL
              ? <button type="button" className="btn wiz-next" onClick={goNext}>Continue</button>
              : <button type="submit" className="btn wiz-next" disabled={!canReserve}>
                  {busy
                    ? "Reserving…"
                    : paymentMode === "desk"
                      ? "Reserve, pay at pickup"
                      : amounts ? `Pay ${money(amounts[paymentOption].payNowCents, cur)} and reserve` : "Reserve & pay"}
                </button>}
          </div>

          {step === TOTAL && (
            <>
              <p className="note">
                {paymentMode === "desk"
                  ? "No payment needed now. You pay at pickup at the desk."
                  : "You'll be taken to our secure Stripe checkout."}
              </p>
            </>
          )}
        </form>
      </div>

      {/* ---------- summary sidebar (sticky on desktop, bottom bar on mobile) ---------- */}
      <aside className="card summary" aria-label="Price summary">
        <h2>Summary</h2>
        {!breakdown ? <p className="note">Pick a car type and dates to see your price.</p> : (
          <>
            {selectedClass && <div className="line"><span>{selectedClass} car</span><span></span></div>}
            <div className="line"><span>{breakdown.days} day{breakdown.days !== 1 ? "s" : ""} rental</span><span>{money(breakdown.vehicleCents, cur)}</span></div>
            {breakdown.insuranceCents > 0 && <div className="line"><span>Insurance</span><span>{money(breakdown.insuranceCents, cur)}</span></div>}
            {breakdown.youngDriverCents > 0 && (
              <div className="line"><span>Young driver fee</span><span>{money(breakdown.youngDriverCents, cur)}</span></div>
            )}
            {breakdown.addOns.filter((l) => l.cents > 0).map((l) => (
              <div className="line" key={l.id}><span>{l.name}{l.qty > 1 ? ` ×${l.qty}` : ""}</span><span>{money(l.cents, cur)}</span></div>
            ))}
            <div className="line total"><span>Rental total</span><span>{money(breakdown.subtotalCents, cur)}</span></div>
            {step === TOTAL && amounts && (
              <div className="line muted">
                <span>{paymentMode === "desk" ? "Due at pickup" : "You pay now"}</span>
                <span>{money(paymentMode === "desk" ? amounts.full.payNowCents : amounts[paymentOption].payNowCents, cur)}</span>
              </div>
            )}
            {breakdown.depositCents !== null && <div className="line muted"><span>Refundable deposit</span><span>{money(breakdown.depositCents, cur)}</span></div>}
          </>
        )}
      </aside>
    </div>
  );
}
