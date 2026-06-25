"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { DatePicker } from "@/components/ui";

interface ClassOption { class: string; fromDayCents: number; depositCents: number | null; cars: number; available: boolean | null; carSlug: string | null }
interface Tier { id: string; name: string; dailyPriceCents: number; coverage: string; isDefault: boolean }
interface AddOn { id: string; name: string; description: string; priceCents: number; pricing: "per_day" | "per_rental" }
interface Breakdown {
  days: number; vehicleCents: number; insuranceCents: number;
  addOns: { id: string; name: string; qty: number; cents: number }[];
  addOnsCents: number; subtotalCents: number; depositCents: number | null; reservationFeeCents: number; currency: string;
}

const money = (c: number, cur = "USD") => (cur === "USD" ? `$${(c / 100).toFixed(2)}` : `${cur} ${(c / 100).toFixed(2)}`);
// Local "today" as ISO yyyy-mm-dd, used only as a min bound on the date pickers.
const todayISO = () => { const d = new Date(); const p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const blankLicense = { nameOnLicense: "", licenseNumber: "", issuingCountry: "Aruba", issueDate: "", expiryDate: "", dob: "" };

// Wizard step labels. The index in this array is the step number (1-based + 1).
const STEPS = ["Car type", "Dates", "Insurance", "Extras", "Driver's licence", "Your details", "Review and confirm"] as const;
const TOTAL = STEPS.length;

export default function BookPage() {
  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [addons, setAddons] = useState<AddOn[]>([]);
  const [selectedClass, setSelectedClass] = useState("");
  const [pickup, setPickup] = useState("");
  const [ret, setRet] = useState("");
  const [tierId, setTierId] = useState<string>("");
  const [qty, setQty] = useState<Record<string, number>>({});
  const [license, setLicense] = useState({ ...blankLicense });
  const [customer, setCustomer] = useState({ name: "", email: "", phone: "" });
  const [paymentOption, setPaymentOption] = useState<"reservation_fee" | "full_deposit" | "cash_deposit">("reservation_fee");
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [breakdown, setBreakdown] = useState<Breakdown | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const idemKey = useMemo(() => (typeof crypto !== "undefined" ? crypto.randomUUID() : String(Math.random())), []);

  // Load catalogs + read the Phase 1 deep-link params (?class, ?pickup, ?return).
  useEffect(() => {
    Promise.all([
      fetch("/api/classes").then((r) => r.json()),
      fetch("/api/insurance").then((r) => r.json()),
      fetch("/api/addons").then((r) => r.json()),
    ]).then(([c, i, a]: [ClassOption[], Tier[], AddOn[]]) => {
      setClasses(c); setTiers(i); setAddons(a);
      const def = i.find((t) => t.isDefault);
      if (def) setTierId(def.id);
      const p = new URLSearchParams(window.location.search);
      if (p.get("pickup")) setPickup(p.get("pickup")!);
      if (p.get("return")) setRet(p.get("return")!);
      const cls = p.get("class") || p.get("car"); // car is legacy; both resolve to a type
      if (cls) { const m = c.find((x) => x.class.toLowerCase() === cls.toLowerCase()); if (m) setSelectedClass(m.class); }
    }).catch(() => setError("Could not load the fleet. Please refresh."));
  }, []);

  // Re-resolve availability + the held car whenever the dates change.
  useEffect(() => {
    if (!pickup || !ret || ret <= pickup) return;
    let live = true;
    fetch(`/api/classes?pickup=${pickup}&return=${ret}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((c: ClassOption[] | null) => { if (live && c) setClasses(c); })
      .catch(() => {});
    return () => { live = false; };
  }, [pickup, ret]);

  const selectedData = classes.find((c) => c.class === selectedClass);
  const carSlug = selectedData?.carSlug ?? null;
  const avail = !pickup || !ret || ret <= pickup ? null
    : selectedData?.available ? { available: true as const }
    : { available: false as const, reason: "No cars of this type are free on those dates" };

  const addOnsBody = useMemo(
    () => Object.entries(qty).filter(([, q]) => q > 0).map(([addOnId, q]) => ({ addOnId, qty: q })),
    [qty],
  );

  // Live USD quote whenever the (resolved) car, dates, insurance or extras change.
  useEffect(() => {
    if (!carSlug || !pickup || !ret || ret <= pickup) { setBreakdown(null); return; }
    const body = { vehicleSlug: carSlug, startDate: pickup, endDate: ret, insuranceTierId: tierId || null, addOns: addOnsBody };
    let live = true;
    fetch("/api/quote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then((r) => (r.ok ? r.json() : null)).then((b) => { if (live) setBreakdown(b); }).catch(() => {});
    return () => { live = false; };
  }, [carSlug, pickup, ret, tierId, addOnsBody]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(""); setBusy(true);
    try {
      if (!carSlug) { setError("Please pick a car type and dates."); setBusy(false); return; }
      const res = await fetch("/api/bookings", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vehicleSlug: carSlug, startDate: pickup, endDate: ret, customer,
          insuranceTierId: tierId || null, addOns: addOnsBody, license,
          acceptTerms, paymentOption, idempotencyKey: idemKey,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data?.error?.message ?? "We could not create your booking."); setBusy(false); return; }
      const checkout = await fetch(`/api/bookings/${data.id}/checkout`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      const co = await checkout.json();
      if (checkout.ok && co.url) { window.location.href = co.url; return; }
      window.location.href = `/book/confirmation?id=${data.id}`;
    } catch { setError("Network error. Please try again."); setBusy(false); }
  }

  const cur = breakdown?.currency ?? "USD";

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

  // The reserve button on the final step is gated exactly as before.
  const canReserve = !busy && acceptTerms && !!avail?.available;

  return (
    <div className="wrap book-grid">
      <div>
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
                  <label className="fld">Pick-up<DatePicker id="pickup" name="pickup" required min={todayISO()} value={pickup} onChange={(iso) => { setPickup(iso); setStepError(""); }} ariaLabel="Pick-up date" /></label>
                  <label className="fld">Return<DatePicker id="ret" name="ret" required min={pickup || todayISO()} value={ret} onChange={(iso) => { setRet(iso); setStepError(""); }} ariaLabel="Return date" /></label>
                </div>
                {selectedClass && avail && (avail.available
                  ? <p className="avail ok">✓ A {selectedClass} car is available on these dates</p>
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
                  <label className="fld">Date of birth<DatePicker id="lic-dob" required value={license.dob} onChange={(iso) => { setLicense({ ...license, dob: iso }); setStepError(""); }} ariaLabel="Date of birth" /></label>
                  <label className="fld">Issue date<DatePicker id="lic-issue" required value={license.issueDate} onChange={(iso) => { setLicense({ ...license, issueDate: iso }); setStepError(""); }} ariaLabel="Licence issue date" /></label>
                  <label className="fld">Expiry date<DatePicker id="lic-expiry" required value={license.expiryDate} onChange={(iso) => { setLicense({ ...license, expiryDate: iso }); setStepError(""); }} ariaLabel="Licence expiry date" /></label>
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
                  <div className="recap-row"><dt>Dates</dt><dd>{pickup && ret ? `${pickup} to ${ret}` : "Not set"}{breakdown ? ` · ${breakdown.days} day${breakdown.days !== 1 ? "s" : ""}` : ""}</dd></div>
                  <div className="recap-row"><dt>Insurance</dt><dd>{tiers.find((t) => t.id === tierId)?.name ?? "Basic"}</dd></div>
                  <div className="recap-row"><dt>Extras</dt><dd>{addOnsBody.length === 0 ? "None" : addons.filter((a) => (qty[a.id] ?? 0) > 0).map((a) => `${a.name}${(qty[a.id] ?? 0) > 1 ? ` ×${qty[a.id]}` : ""}`).join(", ")}</dd></div>
                  <div className="recap-row"><dt>Driver</dt><dd>{license.nameOnLicense || "Not entered"}</dd></div>
                  <div className="recap-row"><dt>Contact</dt><dd>{customer.name || "Not entered"}{customer.email ? ` · ${customer.email}` : ""}</dd></div>
                  {breakdown && <div className="recap-row total"><dt>Rental total</dt><dd>{money(breakdown.subtotalCents, cur)}</dd></div>}
                </dl>

                {breakdown && (
                  <div className="pay-options">
                    <label className="opt"><input type="radio" name="pay" checked={paymentOption === "reservation_fee"} onChange={() => setPaymentOption("reservation_fee")} /><span className="grow">Pay the reservation fee now to hold it</span><span className="price">{money(breakdown.reservationFeeCents, cur)}</span></label>
                    {breakdown.depositCents !== null && <label className="opt"><input type="radio" name="pay" checked={paymentOption === "full_deposit"} onChange={() => setPaymentOption("full_deposit")} /><span className="grow">Pay the full deposit online instead</span><span className="price">{money(breakdown.depositCents, cur)}</span></label>}
                    <label className="opt"><input type="radio" name="pay" checked={paymentOption === "cash_deposit"} onChange={() => setPaymentOption("cash_deposit")} /><span className="grow">Pay deposit in cash at pick-up (reservation fee still applies)</span></label>
                  </div>
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

          {/* ---------- navigation ---------- */}
          <div className="wiz-nav">
            {step > 1
              ? <button type="button" className="btn btn-quiet wiz-back" onClick={goBack}>Back</button>
              : <span />}
            {step < TOTAL
              ? <button type="button" className="btn wiz-next" onClick={goNext}>Continue</button>
              : <button type="submit" className="btn wiz-next" disabled={!canReserve}>{busy ? "Reserving…" : "Reserve & pay"}</button>}
          </div>

          {step === TOTAL && (
            <>
              <p className="note">You&apos;ll be taken to our secure Stripe checkout to pay the {paymentOption === "full_deposit" ? "deposit" : "reservation fee"}.</p>
              <p className="msg err">{error}</p>
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
            {breakdown.addOns.filter((l) => l.cents > 0).map((l) => (
              <div className="line" key={l.id}><span>{l.name}{l.qty > 1 ? ` ×${l.qty}` : ""}</span><span>{money(l.cents, cur)}</span></div>
            ))}
            <div className="line total"><span>Rental total</span><span>{money(breakdown.subtotalCents, cur)}</span></div>
            {breakdown.depositCents !== null && <div className="line muted"><span>Refundable deposit</span><span>{money(breakdown.depositCents, cur)}</span></div>}
          </>
        )}
      </aside>
    </div>
  );
}
