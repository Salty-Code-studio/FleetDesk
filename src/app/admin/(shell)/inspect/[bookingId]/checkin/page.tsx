"use client";

/**
 * Check-in wizard (spec W4, 7 steps). Runs on the STAFF device (admin auth);
 * the device is handed to the customer only at step 6 (rules + signature).
 * Every write is a small PUT to the pickup inspection, so an interrupted
 * check-in resumes exactly where it stopped (state lives server-side).
 */
import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { apiGet, api, apiPut, type ApiError } from "@/app/admin/client";
import { useToast } from "@/app/admin/_ui";
import {
  ANGLES, PhotoCapture, FuelSelector, SignatureCanvas, StepShell,
  capturePhoto, uploadBlob, money, fileUrl,
  type Handover, type InspectionDto,
} from "../../wizard-ui";

const TOTAL = 7;

export default function CheckinWizard() {
  const { bookingId } = useParams<{ bookingId: string }>();
  const router = useRouter();
  const toast = useToast();

  const [data, setData] = useState<Handover | null>(null);
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);

  // step-local state
  const [driverName, setDriverName] = useState("");
  const [driverLicense, setDriverLicense] = useState("");
  const [odometer, setOdometer] = useState("");
  const [borgAmount, setBorgAmount] = useState("");
  const [borgMethod, setBorgMethod] = useState<"cash" | "card">("cash");
  const [signatureBlob, setSignatureBlob] = useState<Blob | null>(null);
  const [overrideNote, setOverrideNote] = useState("");
  const [damageNote, setDamageNote] = useState("");

  const insp: InspectionDto | null = data?.inspections.pickup ?? null;

  const reload = async () => {
    const h = await apiGet<Handover>(`/api/admin/bookings/${bookingId}/handover`);
    setData(h);
    return h;
  };

  useEffect(() => {
    reload()
      .then((h) => {
        setOdometer(h.inspections.pickup?.odometer?.toString() ?? "");
        setBorgAmount((((h.inspections.pickup?.borgReceivedCents ?? h.vehicle.depositCents) ?? 0) / 100).toFixed(0));
      })
      .catch((e: ApiError) => toast.show({ type: "error", message: e.message }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookingId]);

  const put = async (patch: Record<string, unknown>) => {
    await apiPut(`/api/admin/bookings/${bookingId}/inspection/pickup`, patch);
    await reload();
  };

  const guarded = (fn: () => Promise<void>) => async () => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.show({ type: "error", message: (e as ApiError | Error).message ?? "Something went wrong" });
    } finally {
      setBusy(false);
    }
  };

  const setAnglePhoto = (angle: string) => async (file: File) => {
    const key = await capturePhoto(file, { category: "inspection", bookingId, kind: "pickup", label: angle });
    const photos = [...(insp?.photos ?? []).filter((p) => p.label !== angle), { key, label: angle }];
    await put({ photos });
  };

  const anglePhoto = (angle: string) => insp?.photos.find((p) => p.label === angle)?.key ?? null;
  const anglesDone = useMemo(() => ANGLES.every((a) => anglePhoto(a.id)), [insp]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) return <main className="wiz-page"><p className="wiz-sub">Loading booking...</p></main>;

  const b = data.booking;
  const finished = b.status === "picked_up" || b.status === "completed";

  return (
    <main className="wiz-page">
      <h1>Check in: {data.vehicle.name}</h1>
      <p className="wiz-sub">{data.vehicle.plate} · {data.customer.name ?? data.customer.email}</p>

      {finished ? (
        <div className="wiz-card">
          <p>This booking is already checked in. The record lives in the booking drawer.</p>
          <button type="button" className="wiz-btn primary" onClick={() => router.push("/admin")}>Back to the board</button>
        </div>
      ) : null}

      {!finished && step === 1 ? (
        <StepShell step={1} total={TOTAL} title="Verify booking and balance" onNext={() => setStep(2)}>
          <div className="wiz-card">
            {b.priceLines.map((l) => (
              <div className="wiz-row" key={l.label}><span className="muted">{l.label}</span><span>{money(l.cents, b.currency)}</span></div>
            ))}
            <div className="wiz-row"><span className="muted">Paid</span><span>{money(b.amountPaidCents, b.currency)}</span></div>
            <div className="wiz-row"><strong>Balance due at pickup</strong><strong>{money(b.balanceDueCents, b.currency)}</strong></div>
          </div>
          {b.balanceDueCents > 0 ? (
            <button type="button" className="wiz-btn primary" disabled={busy} onClick={guarded(async () => {
              await api(`/api/admin/bookings/${bookingId}/desk-payment`, { amountCents: b.balanceDueCents });
              await reload();
              toast.show({ type: "success", message: "Balance recorded as collected at the desk" });
            })}>
              Record {money(b.balanceDueCents, b.currency)} collected at desk
            </button>
          ) : (
            <p className="wiz-sub">Nothing due. Fully paid.</p>
          )}
          {data.license ? (
            <div className="wiz-card">
              <div className="wiz-row"><span className="muted">Driver on licence</span><span>{data.license.nameOnLicense}</span></div>
              <div className="wiz-row"><span className="muted">Country</span><span>{data.license.issuingCountry}</span></div>
              <div className="wiz-row"><span className="muted">Valid until</span><span>{data.license.expiryDate}</span></div>
            </div>
          ) : (
            <div className="wiz-card">
              <p className="wiz-sub">Desk booking, no licence on file. Note the driver details (the photo in the next step is the licence copy).</p>
              <input className="wiz-input" placeholder="Driver name" value={driverName} onChange={(e) => setDriverName(e.target.value)} />
              <div style={{ height: 8 }} />
              <input className="wiz-input" placeholder="Licence number" value={driverLicense} onChange={(e) => setDriverLicense(e.target.value)} />
              <div style={{ height: 8 }} />
              <button type="button" className="wiz-btn" disabled={busy || !driverName.trim()} onClick={guarded(async () => {
                await put({ notes: `Driver: ${driverName.trim()}${driverLicense.trim() ? `, licence ${driverLicense.trim()}` : ""}` });
                toast.show({ type: "success", message: "Driver details saved" });
              })}>
                Save driver details
              </button>
            </div>
          )}
        </StepShell>
      ) : null}

      {!finished && step === 2 ? (
        <StepShell step={2} total={TOTAL} title="Licence photo" onBack={() => setStep(1)} onNext={() => setStep(3)} nextDisabled={!insp?.licensePhotoKey}>
          <p className="wiz-sub">Photograph the driver&apos;s licence. It lands in private storage, admin eyes only.</p>
          <PhotoCapture label="Licence" photoKey={insp?.licensePhotoKey ?? null} onFile={async (file) => {
            const key = await capturePhoto(file, { category: "license", bookingId });
            await put({ licensePhotoKey: key, licenseCopyReceived: true });
          }} />
        </StepShell>
      ) : null}

      {!finished && step === 3 ? (
        <StepShell step={3} total={TOTAL} title="Walk-around photos" onBack={() => setStep(2)} onNext={() => setStep(4)} nextDisabled={!anglesDone}>
          <p className="wiz-sub">Six angles, every car, every time. Add close-ups for existing damage.</p>
          {ANGLES.map((a) => (
            <div className="wiz-card" key={a.id}>
              <strong>{a.label}</strong>
              <PhotoCapture label={a.label} photoKey={anglePhoto(a.id)} onFile={setAnglePhoto(a.id)} />
            </div>
          ))}
          <div className="wiz-card">
            <strong>Existing damage close-up (optional)</strong>
            <input className="wiz-input" placeholder="What does the photo show? e.g. scratch rear bumper" value={damageNote} onChange={(e) => setDamageNote(e.target.value)} />
            <div style={{ height: 8 }} />
            <PhotoCapture label="Damage close-up" photoKey={null} onFile={async (file) => {
              const note = damageNote.trim() || "existing damage";
              const key = await capturePhoto(file, { category: "inspection", bookingId, kind: "pickup", label: `damage: ${note}` });
              await put({ photos: [...(insp?.photos ?? []), { key, label: `damage: ${note}` }] });
              setDamageNote("");
            }} />
            {(insp?.photos ?? []).filter((p) => p.label.startsWith("damage:")).map((p) => (
              <div className="wiz-row" key={p.key}><span className="muted">{p.label}</span><span>saved</span></div>
            ))}
          </div>
        </StepShell>
      ) : null}

      {!finished && step === 4 ? (
        <StepShell
          step={4} total={TOTAL} title="Odometer and fuel"
          onBack={() => setStep(3)}
          onNext={guarded(async () => {
            if (!odometer.trim()) throw new Error("Enter the odometer reading in whole kilometers");
            const km = Number(odometer);
            if (!Number.isInteger(km) || km < 0) throw new Error("Enter the odometer reading in whole kilometers");
            if (insp?.fuelLevel === null || insp?.fuelLevel === undefined) throw new Error("Tap the fuel level");
            await put({ odometer: km });
            setStep(5);
          })}
          nextDisabled={busy || !odometer.trim()}
        >
          <input className="wiz-input" inputMode="numeric" placeholder="Odometer (km)" value={odometer} onChange={(e) => setOdometer(e.target.value.replace(/\D/g, ""))} />
          <FuelSelector value={insp?.fuelLevel ?? null} onChange={(v) => guarded(() => put({ fuelLevel: v }))()} />
        </StepShell>
      ) : null}

      {!finished && step === 5 ? (
        <StepShell step={5} total={TOTAL} title="Borg (security deposit)" onBack={() => setStep(4)} onNext={() => setStep(6)}>
          <p className="wiz-sub">Refundable, handed back at return. Record what you received.</p>
          <input className="wiz-input" inputMode="numeric" placeholder={`Amount in ${b.currency}`} value={borgAmount} onChange={(e) => setBorgAmount(e.target.value.replace(/\D/g, ""))} />
          <div className="wiz-choice">
            <button type="button" className={borgMethod === "cash" ? "on" : ""} onClick={() => setBorgMethod("cash")}>Cash</button>
            <button type="button" className={borgMethod === "card" ? "on" : ""} onClick={() => setBorgMethod("card")}>Card</button>
          </div>
          <button type="button" className="wiz-btn primary" disabled={busy || !borgAmount} onClick={guarded(async () => {
            await put({ borgReceivedCents: Number(borgAmount) * 100, borgMethod });
            toast.show({ type: "success", message: "Borg recorded" });
          })}>
            Record borg received
          </button>
          <button type="button" className="wiz-btn ghost" disabled={busy} onClick={guarded(async () => {
            await put({ borgReceivedCents: null, borgMethod: null });
            setStep(6);
          })}>
            No borg for this rental
          </button>
          {insp?.borgReceivedCents ? <p className="wiz-sub">On record: {money(insp.borgReceivedCents, b.currency)} in {insp.borgMethod ?? "cash"}.</p> : null}
        </StepShell>
      ) : null}

      {!finished && step === 6 ? (
        <StepShell step={6} total={TOTAL} title="Rules and signature" onBack={() => setStep(5)} onNext={() => setStep(7)} nextDisabled={!insp?.signatureKey || !insp?.rulesSigned}>
          <p className="wiz-sub">Hand the device to the customer to read and sign.</p>
          <div className="wiz-policy">{data.policy?.body ?? "No rental terms published yet."}</div>
          <button type="button" className="wiz-btn" disabled={busy || insp?.rulesSigned} onClick={guarded(async () => {
            await put({ rulesSigned: true, acceptedPolicyVersion: data.policy?.version ?? 0 });
          })}>
            {insp?.rulesSigned ? "Rules accepted" : "Customer accepts the rules"}
          </button>
          <SignatureCanvas onBlob={setSignatureBlob} />
          <button type="button" className="wiz-btn primary" disabled={busy || !signatureBlob} onClick={guarded(async () => {
            const key = await uploadBlob(signatureBlob!, { category: "signature", bookingId });
            await put({ signatureKey: key, agreementSigned: true });
            toast.show({ type: "success", message: "Signature saved" });
          })}>
            Save signature
          </button>
          {insp?.signatureKey ? <img src={fileUrl(insp.signatureKey)} alt="Saved signature" style={{ maxHeight: 80 }} /> : null}
        </StepShell>
      ) : null}

      {!finished && step === 7 ? (
        <StepShell
          step={7} total={TOTAL} title="Finish check-in"
          onBack={() => setStep(6)}
          onNext={guarded(async () => {
            await api(`/api/admin/bookings/${bookingId}/inspection/pickup/complete`,
              b.status === "pending" ? { overrideNote: overrideNote.trim() } : {});
            toast.show({ type: "success", message: "Checked in. Contract is on its way to the customer." });
            router.push("/admin");
          })}
          nextLabel="Complete check-in"
          nextDisabled={busy || (b.status === "pending" && overrideNote.trim().length < 3)}
        >
          <div className="wiz-card">
            {[
              { label: "Balance settled", ok: b.balanceDueCents === 0 },
              { label: "Licence photo", ok: !!insp?.licensePhotoKey },
              { label: "Six walk-around angles", ok: anglesDone },
              { label: "Odometer and fuel", ok: insp?.odometer !== null && insp?.fuelLevel !== null },
              { label: "Borg recorded", ok: insp?.borgReceivedCents !== null },
              { label: "Rules accepted and signed", ok: !!insp?.rulesSigned && !!insp?.signatureKey },
            ].map((c) => (
              <div className="wiz-check" key={c.label}>
                <span>{c.label}</span>
                <span className={`state ${c.ok ? "ok" : "todo"}`}>{c.ok ? "done" : "open"}</span>
              </div>
            ))}
          </div>
          {b.status === "pending" ? (
            <div className="wiz-card">
              <p className="wiz-sub">This booking is not paid online yet. A desk override note is required to hand the car over anyway.</p>
              <textarea className="wiz-input" placeholder="Why is the car going out unpaid?" value={overrideNote} onChange={(e) => setOverrideNote(e.target.value)} />
            </div>
          ) : null}
          <p className="wiz-sub">Completing marks the booking as picked up, generates the contract PDF, and emails it to {data.customer.email}.</p>
        </StepShell>
      ) : null}
    </main>
  );
}
