"use client";

/**
 * Check-in wizard (spec W4). Runs on the STAFF device (admin auth); the
 * device is handed to the customer only for the rules and signature, behind a
 * full-screen handover moment both ways (Flow Desk phase 5). Every write is a
 * small PUT to the pickup inspection, so an interrupted check-in reopens on the
 * first open step (state lives server-side, see wizard-progress.ts).
 */
import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { apiGet, api, apiPut, type ApiError } from "@/app/admin/client";
import { useToast } from "@/app/admin/_ui";
import { DatePicker } from "@/components/ui";
import { licenceDateBounds } from "@/lib/booking/license-bounds";
import { siteConfig } from "@/lib/site-config";
import { formatDateTime } from "@/lib/time/format";
import {
  checkinProgress, checkinResumeStep, checkinFinishLines, firstName, type CheckinFacts,
} from "@/lib/admin/wizard-progress";
import {
  ANGLES, PhotoCapture, FuelSelector, SignatureCanvas, StepShell, HandScreen, FinishScreen, CheckList,
  capturePhoto, uploadBlob, money, fileUrl,
  type Handover, type InspectionDto,
} from "../../wizard-ui";

const KICKER = "Check-in";

const factsOf = (h: Handover): CheckinFacts => {
  const p = h.inspections.pickup;
  return {
    hasLicence: !!h.license,
    licensePhotoKey: p?.licensePhotoKey ?? null,
    photoLabels: (p?.photos ?? []).map((x) => x.label),
    odometer: p?.odometer ?? null,
    fuelLevel: p?.fuelLevel ?? null,
    borgReceivedCents: p?.borgReceivedCents ?? null,
    rulesSigned: !!p?.rulesSigned,
    signatureKey: p?.signatureKey ?? null,
  };
};

const blankLicence = { nameOnLicense: "", licenseNumber: "", issuingCountry: "", issueDate: "", expiryDate: "", dob: "" };
const todayISO = () => { const d = new Date(); const p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

export default function CheckinWizard() {
  const { bookingId } = useParams<{ bookingId: string }>();
  const router = useRouter();
  const toast = useToast();

  const [data, setData] = useState<Handover | null>(null);
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);

  // step-local state
  // The public funnel no longer asks for the licence, so most bookings arrive
  // without one; the desk types it in here and the age gate runs server-side.
  const [licence, setLicence] = useState({ ...blankLicence });
  const licenceBounds = useMemo(() => licenceDateBounds(todayISO()), []);
  const [odometer, setOdometer] = useState("");
  const [borgAmount, setBorgAmount] = useState("");
  const [borgMethod, setBorgMethod] = useState<"cash" | "card">("cash");
  const [signatureBlob, setSignatureBlob] = useState<Blob | null>(null);
  const [overrideNote, setOverrideNote] = useState("");
  const [damageNote, setDamageNote] = useState("");
  // The rules step is three screens: give the phone, customer signs, give it back.
  const [hand, setHand] = useState<"give" | "sign" | "return">("give");
  const [doneLines, setDoneLines] = useState<string[] | null>(null);

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
        setStep(checkinResumeStep(factsOf(h)));
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
  const progress = checkinProgress(factsOf(data));
  const ring = { done: progress.done, total: progress.items.length };
  const who = firstName(data.customer.name, data.customer.email);
  const goToSign = () => { setHand(insp?.signatureKey && insp.rulesSigned ? "return" : "give"); setStep(6); };

  if (doneLines) {
    return (
      <main className="wiz-page">
        <FinishScreen word="Out." title="The car is on the road" lines={doneLines} doneLabel="Back to Today" onDone={() => router.push("/admin")} />
      </main>
    );
  }

  const finished = b.status === "picked_up" || b.status === "completed";

  return (
    <main className="wiz-page">
      <h1>Check in: {data.vehicle.name}</h1>
      <p className="wiz-sub">{data.vehicle.plate} · {data.customer.name ?? data.customer.email}</p>

      {finished ? (
        <div className="wiz-card">
          <p>This booking is already checked in. The record lives in the booking drawer.</p>
          <button type="button" className="wiz-btn primary" onClick={() => router.push("/admin")}>Back to Today</button>
        </div>
      ) : null}

      {!finished && step === 1 ? (
        <StepShell kicker={KICKER} ring={ring} title="Verify booking, balance and licence" onNext={() => setStep(2)} nextDisabled={!data.license}>
          <div className="wiz-card">
            {b.priceLines.map((l) => (
              <div className="wiz-row" key={l.label}><span className="muted">{l.label}</span><span>{money(l.cents, b.currency)}</span></div>
            ))}
            <div className="wiz-row"><span className="muted">Paid</span><span>{money(b.amountPaidCents, b.currency)}</span></div>
            <div className="wiz-row"><strong>Balance due at pickup</strong><strong>{money(b.balanceDueCents, b.currency)}</strong></div>
          </div>
          {b.balanceDueCents > 0 ? (
            <button type="button" className="wiz-btn" disabled={busy} onClick={guarded(async () => {
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
              <div className="wiz-row"><span className="muted">Priced as</span><span>{b.youngDriver ? "Young driver, fee charged" : "No young driver fee"}</span></div>
            </div>
          ) : (
            <div className="wiz-card">
              <p className="wiz-sub">No licence on file yet. Type it in from the card. The number and date of birth are stored encrypted.</p>
              <div className="wiz-fields">
                <input className="wiz-input" placeholder="Name on licence" value={licence.nameOnLicense} onChange={(e) => setLicence({ ...licence, nameOnLicense: e.target.value })} />
                <input className="wiz-input" placeholder="Licence number" value={licence.licenseNumber} onChange={(e) => setLicence({ ...licence, licenseNumber: e.target.value })} />
                <input className="wiz-input" placeholder="Issuing country" value={licence.issuingCountry} onChange={(e) => setLicence({ ...licence, issuingCountry: e.target.value })} />
                <label className="wiz-label">Date of birth<DatePicker id="lic-dob" min={licenceBounds.dob.min} max={licenceBounds.dob.max} value={licence.dob} onChange={(iso) => setLicence({ ...licence, dob: iso })} ariaLabel="Date of birth" /></label>
                <label className="wiz-label">Issue date<DatePicker id="lic-issue" min={licenceBounds.issueDate.min} max={licenceBounds.issueDate.max} value={licence.issueDate} onChange={(iso) => setLicence({ ...licence, issueDate: iso })} ariaLabel="Licence issue date" /></label>
                <label className="wiz-label">Expiry date<DatePicker id="lic-expiry" min={licenceBounds.expiryDate.min} max={licenceBounds.expiryDate.max} value={licence.expiryDate} onChange={(iso) => setLicence({ ...licence, expiryDate: iso })} ariaLabel="Licence expiry date" /></label>
              </div>
              <button type="button" className="wiz-btn" disabled={busy || Object.values(licence).some((v) => !v.trim())} onClick={guarded(async () => {
                await apiPut(`/api/admin/bookings/${bookingId}/license`, licence);
                setLicence({ ...blankLicence });
                await reload();
                toast.show({ type: "success", message: "Licence saved" });
              })}>
                Save licence
              </button>
            </div>
          )}
          {/* Recomputed by the handover on every load, so it survives a reload.
              Hidden when the operator charges no young driver fee at all. */}
          {data.licenceCheck?.mismatch && b.youngDriverFeeCents > 0 ? (
            <p className="wiz-warn" role="status">
              {data.licenceCheck.band === "young"
                ? `The licence says young driver. This booking was priced without the fee (${money(b.youngDriverFeeCents, b.currency)}). Collect it at the desk or change the price in the booking.`
                : `The driver is not a young driver, but the booking includes the young driver fee (${money(b.youngDriverFeeCents, b.currency)}). Refund it or change the price in the booking.`}
            </p>
          ) : null}
          {!data.license ? <p className="wiz-sub">Save the licence to continue.</p> : null}
        </StepShell>
      ) : null}

      {!finished && step === 2 ? (
        <StepShell kicker={KICKER} ring={ring} title="Licence photo" onBack={() => setStep(1)} onNext={() => setStep(3)} nextDisabled={!insp?.licensePhotoKey}>
          <p className="wiz-sub">Photograph the driver&apos;s licence. It lands in private storage, admin eyes only.</p>
          <PhotoCapture label="Licence" photoKey={insp?.licensePhotoKey ?? null} onFile={async (file) => {
            const key = await capturePhoto(file, { category: "license", bookingId });
            await put({ licensePhotoKey: key, licenseCopyReceived: true });
          }} />
        </StepShell>
      ) : null}

      {!finished && step === 3 ? (
        <StepShell kicker={KICKER} ring={ring} title="Walk-around photos" onBack={() => setStep(2)} onNext={() => setStep(4)} nextDisabled={!anglesDone}>
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
          kicker={KICKER} ring={ring} title="Odometer and fuel"
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
        <StepShell kicker={KICKER} ring={ring} title="Borg (security deposit)" onBack={() => setStep(4)} onNext={goToSign}>
          <p className="wiz-sub">Refundable, handed back at return. Record what you received.</p>
          <input className="wiz-input" inputMode="numeric" placeholder={`Amount in ${b.currency}`} value={borgAmount} onChange={(e) => setBorgAmount(e.target.value.replace(/\D/g, ""))} />
          <div className="wiz-choice">
            <button type="button" className={borgMethod === "cash" ? "on" : ""} onClick={() => setBorgMethod("cash")}>Cash</button>
            <button type="button" className={borgMethod === "card" ? "on" : ""} onClick={() => setBorgMethod("card")}>Card</button>
          </div>
          <button type="button" className="wiz-btn" disabled={busy || !borgAmount} onClick={guarded(async () => {
            await put({ borgReceivedCents: Number(borgAmount) * 100, borgMethod });
            toast.show({ type: "success", message: "Borg recorded" });
          })}>
            Record borg received
          </button>
          <button type="button" className="wiz-btn ghost" disabled={busy} onClick={guarded(async () => {
            await put({ borgReceivedCents: null, borgMethod: null });
            goToSign();
          })}>
            No borg for this rental
          </button>
          {insp?.borgReceivedCents ? <p className="wiz-sub">On record: {money(insp.borgReceivedCents, b.currency)} in {insp.borgMethod ?? "cash"}.</p> : null}
        </StepShell>
      ) : null}

      {!finished && step === 6 && hand === "give" ? (
        <HandScreen
          backWord={siteConfig.siteName}
          title={`Hand the phone to ${who}`}
          body={`${who} reads the rental rules and signs with a finger. The phone comes back to you after.`}
          goLabel="Show me the rules"
          onGo={() => setHand("sign")}
          onBack={() => setStep(5)}
        />
      ) : null}

      {!finished && step === 6 && hand === "sign" ? (
        <StepShell kicker={KICKER} ring={ring} title="Read the rules, then sign" onBack={() => setHand("give")} onNext={() => setHand("return")} nextLabel="I'm done" nextDisabled={!insp?.signatureKey || !insp?.rulesSigned}>
          <div className="wiz-policy">{data.policy?.body ?? "No rental terms published yet."}</div>
          <button type="button" className="wiz-btn" disabled={busy || insp?.rulesSigned} onClick={guarded(async () => {
            await put({ rulesSigned: true, acceptedPolicyVersion: data.policy?.version ?? 0 });
          })}>
            {insp?.rulesSigned ? "Rules accepted" : "I accept the rules"}
          </button>
          <SignatureCanvas onBlob={setSignatureBlob} />
          <button type="button" className="wiz-btn" disabled={busy || !signatureBlob} onClick={guarded(async () => {
            const key = await uploadBlob(signatureBlob!, { category: "signature", bookingId });
            await put({ signatureKey: key, agreementSigned: true });
            toast.show({ type: "success", message: "Signature saved" });
          })}>
            Save signature
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {insp?.signatureKey ? <img src={fileUrl(insp.signatureKey)} alt="Saved signature" style={{ maxHeight: 80 }} /> : null}
        </StepShell>
      ) : null}

      {!finished && step === 6 && hand === "return" ? (
        <HandScreen
          backWord={siteConfig.siteName}
          title={`Thanks, ${who}`}
          body="All signed. Please hand the phone back to the desk."
          goLabel="Back at the desk"
          onGo={() => setStep(7)}
        />
      ) : null}

      {!finished && step === 7 ? (
        <StepShell
          kicker={KICKER} ring={ring} title="Finish check-in"
          onBack={goToSign}
          onNext={guarded(async () => {
            await api(`/api/admin/bookings/${bookingId}/inspection/pickup/complete`,
              b.status === "pending" ? { overrideNote: overrideNote.trim() } : {});
            setDoneLines(checkinFinishLines({
              vehicle: data.vehicle.name, plate: data.vehicle.plate, customer: who, email: data.customer.email,
              returnAt: formatDateTime(b.endAt), currency: b.currency,
              balanceDueCents: b.balanceDueCents, wentOutUnpaid: b.status === "pending",
              borgReceivedCents: insp?.borgReceivedCents ?? null, borgMethod: insp?.borgMethod ?? null,
            }));
          })}
          nextLabel="Complete check-in"
          nextDisabled={busy || (b.status === "pending" && overrideNote.trim().length < 3)}
        >
          <CheckList items={[{ label: "Balance settled", ok: b.balanceDueCents === 0 }, ...progress.items]} />
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
