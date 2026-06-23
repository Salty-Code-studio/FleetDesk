"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";

interface ClassOption { class: string; fromDayCents: number; depositCents: number | null; cars: number; available: boolean | null; carSlug: string | null }
interface Tier { id: string; name: string; dailyPriceCents: number; coverage: string; isDefault: boolean }
interface AddOn { id: string; name: string; description: string; priceCents: number; pricing: "per_day" | "per_rental" }
interface Breakdown {
  days: number; vehicleCents: number; insuranceCents: number;
  addOns: { id: string; name: string; qty: number; cents: number }[];
  addOnsCents: number; subtotalCents: number; depositCents: number | null; reservationFeeCents: number; currency: string;
}

const money = (c: number, cur = "USD") => (cur === "USD" ? `$${(c / 100).toFixed(2)}` : `${cur} ${(c / 100).toFixed(2)}`);
const blankLicense = { nameOnLicense: "", licenseNumber: "", issuingCountry: "Aruba", issueDate: "", expiryDate: "", dob: "" };

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

  return (
    <form className="wrap book-grid" onSubmit={submit}>
      <div>
        <div className="card">
          <h2><span className="step-n">1</span>Pick your car type</h2>
          <div className="veh-list">
            {classes.length === 0 && <p className="note">Loading the fleet…</p>}
            {classes.map((c) => (
              <button type="button" key={c.class} className={`veh ${c.class === selectedClass ? "sel" : ""}`}
                disabled={c.available === false}
                onClick={() => setSelectedClass(c.class)}>
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

        <div className="card">
          <h2><span className="step-n">2</span>Dates</h2>
          <div className="two">
            <label className="fld">Pick-up<input type="date" required value={pickup} onChange={(e) => setPickup(e.target.value)} /></label>
            <label className="fld">Return<input type="date" required value={ret} onChange={(e) => setRet(e.target.value)} /></label>
          </div>
          {selectedClass && avail && (avail.available
            ? <p className="avail ok">✓ A {selectedClass} car is available on these dates</p>
            : <p className="avail no">✕ {avail.reason}</p>)}
        </div>

        <div className="card">
          <h2><span className="step-n">3</span>Insurance</h2>
          {tiers.map((t) => (
            <label className="opt" key={t.id}>
              <input type="radio" name="tier" checked={tierId === t.id} onChange={() => setTierId(t.id)} />
              <span className="grow"><b>{t.name}</b>{t.coverage ? <><br /><span className="meta">{t.coverage}</span></> : null}</span>
              <span className="price">{t.dailyPriceCents === 0 ? "included" : `${money(t.dailyPriceCents, cur)}/day`}</span>
            </label>
          ))}
        </div>

        {addons.length > 0 && (
          <div className="card">
            <h2><span className="step-n">4</span>Extras</h2>
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

        <div className="card">
          <h2><span className="step-n">5</span>Driver&apos;s licence</h2>
          <p className="note">We encrypt these details. They are required to rent and verified at pick-up.</p>
          <div className="two">
            <label className="fld">Name on licence<input required value={license.nameOnLicense} onChange={(e) => setLicense({ ...license, nameOnLicense: e.target.value })} /></label>
            <label className="fld">Licence number<input required value={license.licenseNumber} onChange={(e) => setLicense({ ...license, licenseNumber: e.target.value })} /></label>
            <label className="fld">Issuing country<input required value={license.issuingCountry} onChange={(e) => setLicense({ ...license, issuingCountry: e.target.value })} /></label>
            <label className="fld">Date of birth<input type="date" required value={license.dob} onChange={(e) => setLicense({ ...license, dob: e.target.value })} /></label>
            <label className="fld">Issue date<input type="date" required value={license.issueDate} onChange={(e) => setLicense({ ...license, issueDate: e.target.value })} /></label>
            <label className="fld">Expiry date<input type="date" required value={license.expiryDate} onChange={(e) => setLicense({ ...license, expiryDate: e.target.value })} /></label>
          </div>
        </div>

        <div className="card">
          <h2><span className="step-n">6</span>Your details</h2>
          <div className="two">
            <label className="fld">Full name<input required value={customer.name} onChange={(e) => setCustomer({ ...customer, name: e.target.value })} /></label>
            <label className="fld">Email<input type="email" required value={customer.email} onChange={(e) => setCustomer({ ...customer, email: e.target.value })} /></label>
            <label className="fld">Phone<input value={customer.phone} onChange={(e) => setCustomer({ ...customer, phone: e.target.value })} /></label>
          </div>
        </div>
      </div>

      <aside className="card summary">
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

            <div style={{ marginTop: "1rem" }}>
              <label className="opt"><input type="radio" name="pay" checked={paymentOption === "reservation_fee"} onChange={() => setPaymentOption("reservation_fee")} /><span className="grow">Pay the reservation fee now to hold it</span><span className="price">{money(breakdown.reservationFeeCents, cur)}</span></label>
              {breakdown.depositCents !== null && <label className="opt"><input type="radio" name="pay" checked={paymentOption === "full_deposit"} onChange={() => setPaymentOption("full_deposit")} /><span className="grow">Pay the full deposit online instead</span><span className="price">{money(breakdown.depositCents, cur)}</span></label>}
              <label className="opt"><input type="radio" name="pay" checked={paymentOption === "cash_deposit"} onChange={() => setPaymentOption("cash_deposit")} /><span className="grow">Pay deposit in cash at pick-up (reservation fee still applies)</span></label>
            </div>

            <label className="terms" style={{ margin: "1rem 0" }}>
              <input type="checkbox" checked={acceptTerms} onChange={(e) => setAcceptTerms(e.target.checked)} />
              <span>I accept the <a href="/policies/rental-terms" target="_blank">rental terms</a>, <a href="/policies/cancellation" target="_blank">cancellation policy</a>, and <a href="/policies/privacy" target="_blank">privacy policy</a>.</span>
            </label>

            <button className="btn" disabled={busy || !acceptTerms || !(avail?.available)}>{busy ? "Reserving…" : "Reserve & pay"}</button>
            <p className="note">You&apos;ll be taken to our secure Stripe checkout to pay the {paymentOption === "full_deposit" ? "deposit" : "reservation fee"}.</p>
            <p className="msg err">{error}</p>
          </>
        )}
      </aside>
    </form>
  );
}
