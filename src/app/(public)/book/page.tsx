"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { DatePicker, TimeSelect } from "@/components/ui";
import { licenceDateBounds } from "@/lib/booking/license-bounds";
import { paymentAmounts, depositSettingsFromSnapshot } from "@/lib/payments/amounts";

interface ClassOption { class: string; fromDayCents: number; depositCents: number | null; cars: number; available: boolean | null; carSlug: string | null }
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
const blankLicense = { nameOnLicense: "", licenseNumber: "", issuingCountry: "Aruba", issueDate: "", expiryDate: "", dob: "" };

// Wizard step labels. The index in this array is the step number (1-based + 1).
const STEPS = ["Car type", "Dates", "Insurance", "Extras", "Driver's licence", "Your details", "Review and confirm"] as const;
const TOTAL = STEPS.length;

// ---------------------------------------------------------------------------
// Wizard state persistence: everything the customer has entered survives a
// refresh or an accidental tab close, keyed under one sessionStorage entry so
// a resumed session (or a "back out of Stripe, come back" round trip) doesn't
// force them to redo the whole form. Cleared once a checkout redirect begins
// or (Task 12) when the confirmation page mounts.
// ---------------------------------------------------------------------------
const WIZARD_STORAGE_KEY = "book-wizard-v1";

interface WizardStorage {
  step?: number;
  selectedClass?: string;
  pickup?: string; ret?: string; pickupTime?: string; retTime?: string;
  tierId?: string;
  qty?: Record<string, number>;
  license?: typeof blankLicense;
  customer?: { name: string; email: string; phone: string };
  paymentOption?: "deposit" | "full";
  acceptTerms?: boolean;
  driverAge?: "" | "young" | "standard";
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
  const [license, setLicense] = useState({ ...blankLicense });
  const [customer, setCustomer] = useState({ name: "", email: "", phone: "" });
  const [paymentOption, setPaymentOption] = useState<"deposit" | "full">("deposit");
  const [acceptTerms, setAcceptTerms] = useState(false);
  // wave-05: booking-config knobs (age band labels + fee) and the wizard's
  // claimed age band — a PRICING HINT ONLY; the licence DOB decides at submit.
  const [cfg, setCfg] = useState({ minDriverAge: 18, youngDriverAge: 21, youngDriverFeeCentsPerDay: 0 });
  const [driverAge, setDriverAge] = useState<"" | "young" | "standard">("");
  const [priceNotice, setPriceNotice] = useState("");
  const priceAcknowledged = useRef(false);
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

  // Computed once per mount: a wizard session never spans midnight in practice,
  // and recomputing per render would churn the DatePicker's year list.
  const licenceBounds = useMemo(() => licenceDateBounds(todayISO()), []);

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
    setError(""); setBusy(true);
    try {
      if (!carSlug) { setError("Please pick a car type and dates."); setBusy(false); return; }
      const res = await fetch("/api/bookings", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vehicleSlug: carSlug, startAt, endAt, customer,
          insuranceTierId: tierId || null, addOns: addOnsBody, license,
          acceptTerms,
          // Desk mode never charges online, so there is no deposit-vs-full
          // choice to make: always send "full", since the whole balance is
          // due at pickup either way.
          paymentOption: paymentMode === "desk" ? "full" : paymentOption,
          idempotencyKey: idemKey,
          // The claimed age band, so the server's mismatch check compares the
          // claim against the licence DOB truth instead of always assuming "no".
          youngDriver: driverAge === "young",
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data?.error?.message ?? "We could not create your booking."); setBusy(false); return; }
      if (data.priceAdjusted && !priceAcknowledged.current) {
        priceAcknowledged.current = true;
        if (data.breakdown) setBreakdown(data.breakdown);
        setPriceNotice(
          data.breakdown?.youngDriverCents > 0
            ? "We checked the driver's date of birth on the licence and added the young driver fee. Your updated total is shown in the summary. Tap the button again to confirm and pay."
            : "We checked the driver's date of birth on the licence and the young driver fee does not apply. Your updated, lower total is shown in the summary. Tap the button again to confirm and pay.",
        );
        setBusy(false);
        return;
      }
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
  const [step, setStep] = useState(1); // 1..TOTAL
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
    if (stored.license !== undefined) setLicense({ ...blankLicense, ...stored.license });
    if (stored.customer !== undefined) setCustomer(stored.customer);
    if (stored.paymentOption !== undefined) setPaymentOption(stored.paymentOption);
    if (stored.acceptTerms !== undefined) setAcceptTerms(stored.acceptTerms);
    if (stored.driverAge !== undefined) setDriverAge(stored.driverAge);
    if (stored.step !== undefined) setStep(Math.min(TOTAL, Math.max(1, stored.step)));
  }, []);

  // Persist the whole wizard so far (all step fields incl. licence + times) on
  // every change. Restored above (mount-only effect); cleared once a checkout
  // redirect begins (or, Task 12, when confirmation mounts).
  useEffect(() => {
    try {
      const data: WizardStorage = {
        step, selectedClass, pickup, ret, pickupTime, retTime, tierId, qty, license, customer, paymentOption, acceptTerms, driverAge,
      };
      window.sessionStorage.setItem(WIZARD_STORAGE_KEY, JSON.stringify(data));
    } catch { /* storage unavailable (private mode, quota) — degrade to no persistence */ }
  }, [step, selectedClass, pickup, ret, pickupTime, retTime, tierId, qty, license, customer, paymentOption, acceptTerms, driverAge]);

  // On step change, move focus to the new step heading (skip the very first paint).
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    headingRef.current?.focus();
  }, [step]);

  // Validate the current step. Returns "" when valid, else a message. Side-effect:
  // focuses the first offending field so keyboard users land in the right place.
  function validateStep(n: number): string {
    if (n === 1) {
      if (!selectedClass) return "Please choose a car type to continue.";
    }
    if (n === 2) {
      if (!pickup || !ret) { focusField("[name='pickup'],#pickup"); return "Please choose your pick-up and return dates."; }
      if (ret <= pickup) { focusField("#ret"); return "The return date must be after the pick-up date."; }
      if (!pickupTime) { focusField("#pickup-time"); return "Please choose a pick-up time."; }
      if (!retTime) { focusField("#ret-time"); return "Please choose a return time."; }
      if (!driverAge) return "Please tell us the main driver's age so we can show the right price.";
      if (avail && !avail.available) return avail.reason;
      if (selectedClass && !avail) return "Please choose your pick-up and return dates.";
    }
    if (n === 5) {
      const L = license;
      if (!L.nameOnLicense) { focusField("#lic-name"); return "Please enter the name on the licence."; }
      if (!L.licenseNumber) { focusField("#lic-num"); return "Please enter the licence number."; }
      if (!L.issuingCountry) { focusField("#lic-country"); return "Please enter the issuing country."; }
      if (!L.dob) { focusField("#lic-dob"); return "Please enter the date of birth."; }
      if (!L.issueDate) { focusField("#lic-issue"); return "Please enter the issue date."; }
      if (!L.expiryDate) { focusField("#lic-expiry"); return "Please enter the expiry date."; }
    }
    if (n === 6) {
      if (!customer.name) { focusField("#cust-name"); return "Please enter your full name."; }
      if (!customer.email) { focusField("#cust-email"); return "Please enter your email."; }
      if (!customer.phone) { focusField("#cust-phone"); return "Please enter your phone number."; }
    }
    if (n === 7) {
      if (!acceptTerms) { focusField("#accept-terms"); return "Please accept the terms to reserve."; }
      if (!avail?.available) return "Your dates are no longer available. Please go back and adjust them.";
    }
    return "";
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
    setStep((s) => Math.min(TOTAL, s + 1));
  }
  function goBack() {
    setStepError("");
    setDir("back");
    setStep((s) => Math.max(1, s - 1));
  }
  // Stepper jump: only completed (earlier) steps are reachable.
  function jumpTo(n: number) {
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
  const canReserve = !busy && acceptTerms && !!avail?.available && !!driverAge;

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
            {STEPS.map((label, i) => {
              const n = i + 1;
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
                      {state === "done" ? "✓" : n}
                    </span>
                    <span className="stepper-label">{label}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        {/* announce the active step to screen readers */}
        <p className="sr-only" aria-live="polite">{`Step ${step} of ${TOTAL}, ${STEPS[step - 1]}`}</p>

        <form onSubmit={submit}>
          <div
            ref={panelRef}
            className={`wiz-panel ${dir === "fwd" ? "from-right" : "from-left"}`}
            key={step}
          >
            {/* ---- Step 1 · Car type ---- */}
            {step === 1 && (
              <div className="card">
                <h2 ref={headingRef} tabIndex={-1}><span className="step-n">1</span>Pick your car type</h2>
                <div className="veh-list">
                  {classes.length === 0 && <p className="note">Loading the fleet…</p>}
                  {classes.map((c) => (
                    <button type="button" key={c.class} className={`veh ${c.class === selectedClass ? "sel" : ""}`}
                      disabled={c.available === false}
                      onClick={() => { setSelectedClass(c.class); setStepError(""); }}>
                      <span>
                        <span className="nm">{c.class}</span><br />
                        <span className="meta">
                          {c.cars} car{c.cars !== 1 ? "s" : ""} in this class
                          {c.available === false ? " · none free on those dates" : ""}
                        </span>
                      </span>
                      <span className="price"><b>{money(c.fromDayCents, "USD")}</b><br /><span className="meta">/ day</span></span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* ---- Step 2 · Dates ---- */}
            {step === 2 && (
              <div className="card">
                <h2 ref={headingRef} tabIndex={-1}><span className="step-n">2</span>Dates</h2>
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
                </div>
                {selectedClass && avail && (avail.available
                  ? <p className="avail ok">✓ A {selectedClass} car is available then</p>
                  : <p className="avail no">✕ {avail.reason}</p>)}
              </div>
            )}

            {/* ---- Step 3 · Insurance ---- */}
            {step === 3 && (
              <div className="card">
                <h2 ref={headingRef} tabIndex={-1}><span className="step-n">3</span>Insurance</h2>
                {tiers.map((t) => (
                  <label className="opt" key={t.id}>
                    <input type="radio" name="tier" checked={tierId === t.id} onChange={() => setTierId(t.id)} />
                    <span className="grow"><b>{t.name}</b>{t.coverage ? <><br /><span className="meta">{t.coverage}</span></> : null}</span>
                    <span className="price">{t.dailyPriceCents === 0 ? "included" : `${money(t.dailyPriceCents, cur)}/day`}</span>
                  </label>
                ))}
              </div>
            )}

            {/* ---- Step 4 · Extras ---- */}
            {step === 4 && (
              <div className="card">
                <h2 ref={headingRef} tabIndex={-1}><span className="step-n">4</span>Extras</h2>
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

            {/* ---- Step 5 · Driver's licence ---- */}
            {step === 5 && (
              <div className="card">
                <h2 ref={headingRef} tabIndex={-1}><span className="step-n">5</span>Driver&apos;s licence</h2>
                <p className="note">We encrypt these details. They are required to rent and verified at pick-up.</p>
                <div className="two">
                  <label className="fld">Name on licence<input id="lic-name" required value={license.nameOnLicense} onChange={(e) => { setLicense({ ...license, nameOnLicense: e.target.value }); setStepError(""); }} /></label>
                  <label className="fld">Licence number<input id="lic-num" required value={license.licenseNumber} onChange={(e) => { setLicense({ ...license, licenseNumber: e.target.value }); setStepError(""); }} /></label>
                  <label className="fld">Issuing country<input id="lic-country" required value={license.issuingCountry} onChange={(e) => { setLicense({ ...license, issuingCountry: e.target.value }); setStepError(""); }} /></label>
                  <label className="fld">Date of birth<DatePicker id="lic-dob" required min={licenceBounds.dob.min} max={licenceBounds.dob.max} value={license.dob} onChange={(iso) => { setLicense({ ...license, dob: iso }); setStepError(""); }} ariaLabel="Date of birth" /></label>
                  <label className="fld">Issue date<DatePicker id="lic-issue" required min={licenceBounds.issueDate.min} max={licenceBounds.issueDate.max} value={license.issueDate} onChange={(iso) => { setLicense({ ...license, issueDate: iso }); setStepError(""); }} ariaLabel="Licence issue date" /></label>
                  <label className="fld">Expiry date<DatePicker id="lic-expiry" required min={licenceBounds.expiryDate.min} max={licenceBounds.expiryDate.max} value={license.expiryDate} onChange={(iso) => { setLicense({ ...license, expiryDate: iso }); setStepError(""); }} ariaLabel="Licence expiry date" /></label>
                </div>
              </div>
            )}

            {/* ---- Step 6 · Your details ---- */}
            {step === 6 && (
              <div className="card">
                <h2 ref={headingRef} tabIndex={-1}><span className="step-n">6</span>Your details</h2>
                <div className="two">
                  <label className="fld">Full name<input id="cust-name" required value={customer.name} onChange={(e) => { setCustomer({ ...customer, name: e.target.value }); setStepError(""); }} /></label>
                  <label className="fld">Email<input id="cust-email" type="email" required value={customer.email} onChange={(e) => { setCustomer({ ...customer, email: e.target.value }); setStepError(""); }} /></label>
                  <label className="fld">Phone<input id="cust-phone" value={customer.phone} onChange={(e) => { setCustomer({ ...customer, phone: e.target.value }); setStepError(""); }} /></label>
                </div>
              </div>
            )}

            {/* ---- Step 7 · Review and confirm ---- */}
            {step === 7 && (
              <div className="card">
                <h2 ref={headingRef} tabIndex={-1}><span className="step-n">7</span>Review and confirm</h2>

                <dl className="recap">
                  <div className="recap-row"><dt>Car type</dt><dd>{selectedClass || "Not chosen yet"}</dd></div>
                  <div className="recap-row"><dt>Dates</dt><dd>{pickup && ret ? `Pick-up ${pickup} at ${pickupTime} to Return ${ret} at ${retTime}` : "Not set"}{breakdown ? ` · ${breakdown.days} day${breakdown.days !== 1 ? "s" : ""}` : ""}</dd></div>
                  <div className="recap-row"><dt>Insurance</dt><dd>{tiers.find((t) => t.id === tierId)?.name ?? "Basic"}</dd></div>
                  <div className="recap-row"><dt>Extras</dt><dd>{addOnsBody.length === 0 ? "None" : addons.filter((a) => (qty[a.id] ?? 0) > 0).map((a) => `${a.name}${(qty[a.id] ?? 0) > 1 ? ` ×${qty[a.id]}` : ""}`).join(", ")}</dd></div>
                  <div className="recap-row"><dt>Driver</dt><dd>{license.nameOnLicense || "Not entered"}</dd></div>
                  <div className="recap-row"><dt>Driver age</dt><dd>{driverAge === "young" ? `${cfg.minDriverAge} to ${cfg.youngDriverAge - 1}` : driverAge === "standard" ? `${cfg.youngDriverAge} or older` : "Not set"}</dd></div>
                  <div className="recap-row"><dt>Contact</dt><dd>{customer.name || "Not entered"}{customer.email ? ` · ${customer.email}` : ""}</dd></div>
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
              {priceNotice && <p className="msg price-notice" role="status" aria-live="polite">{priceNotice}</p>}
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
