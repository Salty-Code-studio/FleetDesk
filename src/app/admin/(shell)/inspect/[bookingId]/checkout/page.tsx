"use client";

/**
 * Check-out wizard (spec W4). Reopens on the first open step and ends on a
 * finish screen that says what got done (Flow Desk phase 5). Step one asks one
 * question: "No new damage" skips ahead; "New damage" asks for a note and a
 * photo per damage. Damage already found at pickup is shown for comparison.
 * The borg button records returned in full / partial / withheld; a reason is
 * required whenever anything is withheld.
 */
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { apiGet, api, apiPut, type ApiError } from "@/app/admin/client";
import { useToast } from "@/app/admin/_ui";
import {
  checkoutProgress, checkoutResumeStep, checkoutFinishLines, type CheckoutFacts, type FinishLine,
} from "@/lib/admin/wizard-progress";
import {
  PhotoCapture, FuelSelector, StepShell, FinishScreen, CheckList,
  capturePhoto, money, fileUrl, FUEL_LABELS,
  type Handover, type InspectionDto,
} from "../../wizard-ui";

const KICKER = "Check-out";

const factsOf = (h: Handover): CheckoutFacts => {
  const r = h.inspections.return;
  return {
    // A damage photo can be uploaded before step one saves its flags, so a
    // photo without flags is unsaved, unless a later step already happened.
    reviewSaved: r !== null && (
      r.damageFlags.length > 0 || r.photos.length === 0
      || r.odometer !== null || r.fuelLevel !== null || r.keysReturned || r.borgReturnedCents !== null
    ),
    odometer: r?.odometer ?? null,
    fuelLevel: r?.fuelLevel ?? null,
    borgReceivedCents: h.inspections.pickup?.borgReceivedCents ?? null,
    borgReturnedCents: r?.borgReturnedCents ?? null,
    keysReturned: !!r?.keysReturned,
  };
};

export default function CheckoutWizard() {
  const { bookingId } = useParams<{ bookingId: string }>();
  const router = useRouter();
  const toast = useToast();

  const [data, setData] = useState<Handover | null>(null);
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [odometer, setOdometer] = useState("");
  // "New damage" opens the photo list; each photo carries its own note.
  const [newDamage, setNewDamage] = useState(false);
  const [damageNote, setDamageNote] = useState("");
  const [borgChoice, setBorgChoice] = useState<"full" | "partial" | "withheld" | null>(null);
  const [partialReturned, setPartialReturned] = useState("");
  const [withheldReason, setWithheldReason] = useState("");
  const [doneLines, setDoneLines] = useState<FinishLine[] | null>(null);

  const pickup: InspectionDto | null = data?.inspections.pickup ?? null;
  const ret: InspectionDto | null = data?.inspections.return ?? null;

  const reload = async () => {
    const h = await apiGet<Handover>(`/api/admin/bookings/${bookingId}/handover`);
    setData(h);
    return h;
  };

  useEffect(() => {
    reload()
      .then((h) => {
        setOdometer(h.inspections.return?.odometer?.toString() ?? "");
        // Flags saved on an earlier visit reopen the damage list.
        if ((h.inspections.return?.damageFlags ?? []).length) setNewDamage(true);
        // A settled borg comes back as the choice it was, so resuming on step
        // three neither blocks Next nor invites overwriting a withhold.
        const r = h.inspections.return;
        const got = h.inspections.pickup?.borgReceivedCents ?? null;
        if (r && got !== null && r.borgReturnedCents !== null) {
          setBorgChoice(r.borgReturnedCents >= got ? "full" : r.borgReturnedCents === 0 ? "withheld" : "partial");
          if (r.borgReturnedCents > 0 && r.borgReturnedCents < got) setPartialReturned(String(r.borgReturnedCents / 100));
          setWithheldReason(r.borgWithheldReason ?? "");
        }
        setStep(checkoutResumeStep(factsOf(h)));
      })
      .catch((e: ApiError) => toast.show({ type: "error", message: e.message }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookingId]);

  const put = async (patch: Record<string, unknown>) => {
    await apiPut(`/api/admin/bookings/${bookingId}/inspection/return`, patch);
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

  // Each damage photo is saved with its note as a flag straight away, so a
  // reload never loses one.
  const addDamage = async (file: File) => {
    // The note is optional: a photo is never thrown away for a missing word.
    const note = damageNote.trim() || "new damage";
    const key = await capturePhoto(file, { category: "inspection", bookingId, kind: "return", label: `damage: ${note}` });
    await put({
      photos: [...(ret?.photos ?? []), { key, label: `damage: ${note}` }],
      damageFlags: [...(ret?.damageFlags ?? []), { photoKey: key, note }],
    });
    setDamageNote("");
  };

  const removeDamage = (photoKey: string) => guarded(async () => {
    await put({
      photos: (ret?.photos ?? []).filter((p) => p.key !== photoKey),
      damageFlags: (ret?.damageFlags ?? []).filter((f) => f.photoKey !== photoKey),
    });
  });

  if (!data) return <main className="wiz-page"><p className="wiz-sub">Loading booking...</p></main>;

  const b = data.booking;
  const received = pickup?.borgReceivedCents ?? null;
  const finished = b.status === "completed";
  const flags = ret?.damageFlags ?? [];
  const pickupDamage = (pickup?.photos ?? []).filter((p) => p.label.startsWith("damage:"));
  const progress = checkoutProgress(factsOf(data));
  const ring = { done: progress.done, total: progress.items.length };

  if (doneLines) {
    return (
      <main className="wiz-page">
        <FinishScreen word="Back." title="The car is home" lines={doneLines} doneLabel="Back to Today" onDone={() => router.push("/admin")} />
      </main>
    );
  }

  return (
    <main className="wiz-page">
      <h1>Check out: {data.vehicle.name}</h1>
      <p className="wiz-sub">{data.vehicle.plate} · {data.customer.name ?? data.customer.email}</p>

      {finished ? (
        <div className="wiz-card">
          <p>This booking is already completed.</p>
          <button type="button" className="wiz-btn primary" onClick={() => router.push("/admin")}>Back to Today</button>
        </div>
      ) : null}

      {!finished && step === 1 ? (
        <StepShell
          kicker={KICKER} ring={ring} title="Any new damage?"
          onNext={guarded(async () => {
            if (newDamage && flags.length === 0) throw new Error("Photograph the new damage, or tap No new damage");
            setStep(2);
          })}
          nextDisabled={busy || !factsOf(data).reviewSaved || (newDamage && flags.length === 0)}
        >
          <p className="wiz-sub">Walk around the car. Only photograph damage that was not there at pickup.</p>
          {pickupDamage.length ? (
            <div className="wiz-card">
              <strong>Already there at pickup</strong>
              <div className="wiz-damage-list" style={{ marginTop: 8 }}>
                {pickupDamage.map((p) => (
                  <div className="wiz-damage-item" key={p.key}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={fileUrl(p.key)} alt={p.label} />
                    <span>{p.label.slice("damage:".length).trim()}</span>
                    <span />
                  </div>
                ))}
              </div>
            </div>
          ) : pickup?.damageCheck === "none" ? <p className="wiz-sub">No damage was found at pickup.</p> : null}
          <div className="wiz-answer">
            <button type="button" className={`wiz-btn${!newDamage && factsOf(data).reviewSaved ? " on" : ""}`} disabled={busy || flags.length > 0} onClick={guarded(async () => {
              await put({ damageFlags: [] });
              setNewDamage(false);
              setStep(2);
            })}>
              No new damage
            </button>
            <button type="button" className={`wiz-btn${newDamage ? " on" : ""}`} disabled={busy} onClick={() => setNewDamage(true)}>
              New damage
            </button>
          </div>
          {flags.length > 0 ? <p className="wiz-sub">Remove the damage photos below to switch to No new damage.</p> : null}
          {newDamage ? (
            <div className="wiz-card">
              <strong>Photograph each new damage</strong>
              <p className="wiz-sub">Take or upload a photo of each one. The owner gets a warning bell.</p>
              <input className="wiz-input" placeholder="What? (optional) e.g. dent front left door" value={damageNote} onChange={(e) => setDamageNote(e.target.value)} />
              <div style={{ height: 8 }} />
              <PhotoCapture label="New damage" photoKey={null} emptyText={flags.length ? "Add another damage photo" : "No damage photo yet"} onFile={addDamage} />
              {flags.length ? (
                <div className="wiz-damage-list" style={{ marginTop: 12 }}>
                  {flags.map((f) => (
                    <div className="wiz-damage-item" key={f.photoKey}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={fileUrl(f.photoKey)} alt={f.note} />
                      <span>{f.note}</span>
                      <button type="button" className="wiz-btn ghost" disabled={busy} onClick={removeDamage(f.photoKey)}>Remove</button>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </StepShell>
      ) : null}

      {!finished && step === 2 ? (
        <StepShell
          kicker={KICKER} ring={ring} title="Odometer and fuel"
          onBack={() => setStep(1)}
          onNext={guarded(async () => {
            if (!odometer.trim()) throw new Error("Enter the odometer reading in whole kilometers");
            const km = Number(odometer);
            if (!Number.isInteger(km) || km < 0) throw new Error("Enter the odometer reading in whole kilometers");
            if (ret?.fuelLevel === null || ret?.fuelLevel === undefined) throw new Error("Tap the fuel level");
            await put({ odometer: km });
            setStep(3);
          })}
          nextDisabled={busy || !odometer.trim()}
        >
          <input className="wiz-input" inputMode="numeric" placeholder="Odometer (km)" value={odometer} onChange={(e) => setOdometer(e.target.value.replace(/\D/g, ""))} />
          {pickup?.odometer !== null && pickup?.odometer !== undefined && odometer ? (
            <p className="wiz-sub">Driven this rental: {Math.max(0, Number(odometer) - pickup.odometer)} km</p>
          ) : null}
          <FuelSelector value={ret?.fuelLevel ?? null} onChange={(v) => guarded(() => put({ fuelLevel: v }))()} />
          {pickup?.fuelLevel !== null && pickup?.fuelLevel !== undefined ? (
            <p className="wiz-sub">Fuel at pickup was {FUEL_LABELS[pickup.fuelLevel]}.</p>
          ) : null}
        </StepShell>
      ) : null}

      {!finished && step === 3 ? (
        <StepShell
          kicker={KICKER} ring={ring} title="Borg return and keys"
          onBack={() => setStep(2)}
          onNext={guarded(async () => {
            if (received !== null) {
              if (!borgChoice) throw new Error("Pick a borg outcome first");
              if (borgChoice === "partial" && !partialReturned.trim()) throw new Error("Enter the amount returned");
              const returned = borgChoice === "full" ? received : borgChoice === "withheld" ? 0 : Number(partialReturned) * 100;
              if (!Number.isInteger(returned) || returned < 0 || returned > received) throw new Error("Returned amount must be between 0 and what was received");
              const withheld = received - returned;
              if (withheld > 0 && !withheldReason.trim()) throw new Error("A reason is required when withholding borg");
              await put({
                borgReturnedCents: returned,
                borgWithheldCents: withheld,
                borgWithheldReason: withheld > 0 ? withheldReason.trim() : null,
              });
            }
            setStep(4);
          })}
          nextDisabled={busy || (borgChoice === "partial" && !partialReturned.trim())}
        >
          {received !== null ? (
            <>
              <p className="wiz-sub">Borg received at pickup: {money(received, b.currency)} in {pickup?.borgMethod ?? "cash"}.</p>
              <div className="wiz-choice">
                <button type="button" className={borgChoice === "full" ? "on" : ""} onClick={() => setBorgChoice("full")}>Returned in full</button>
                <button type="button" className={borgChoice === "partial" ? "on" : ""} onClick={() => setBorgChoice("partial")}>Partially withheld</button>
                <button type="button" className={borgChoice === "withheld" ? "on" : ""} onClick={() => setBorgChoice("withheld")}>Fully withheld</button>
              </div>
              {borgChoice === "partial" ? (
                <input className="wiz-input" inputMode="numeric" placeholder={`Amount returned in ${b.currency}`} value={partialReturned} onChange={(e) => setPartialReturned(e.target.value.replace(/\D/g, ""))} />
              ) : null}
              {borgChoice === "partial" || borgChoice === "withheld" ? (
                <textarea className="wiz-input" placeholder="Reason (required when withholding)" value={withheldReason} onChange={(e) => setWithheldReason(e.target.value)} />
              ) : null}
            </>
          ) : (
            <p className="wiz-sub">No borg was recorded at pickup. Nothing to hand back.</p>
          )}
          <button type="button" className="wiz-btn" disabled={busy || ret?.keysReturned} onClick={guarded(async () => {
            await put({ keysReturned: true });
          })}>
            {ret?.keysReturned ? "Keys returned" : "Mark keys returned"}
          </button>
        </StepShell>
      ) : null}

      {!finished && step === 4 ? (
        <StepShell
          kicker={KICKER} ring={ring} title="Finish check-out"
          onBack={() => setStep(3)}
          onNext={guarded(async () => {
            await api(`/api/admin/bookings/${bookingId}/inspection/return/complete`, {});
            const km = ret?.odometer != null && pickup?.odometer != null ? Math.max(0, ret.odometer - pickup.odometer) : null;
            setDoneLines(checkoutFinishLines({
              vehicle: data.vehicle.name, plate: data.vehicle.plate, currency: b.currency, kmDriven: km,
              borgReceivedCents: received, borgReturnedCents: ret?.borgReturnedCents ?? null,
              damageCount: ret?.damageFlags.length ?? 0,
            }));
          })}
          nextLabel="Complete check-out"
          nextDisabled={busy}
        >
          <CheckList items={progress.items} />
          {(ret?.damageFlags.length ?? 0) > 0 ? (
            <p className="wiz-sub">New damage flagged: the owner gets a warning bell and the summary email mentions it.</p>
          ) : null}
        </StepShell>
      ) : null}
    </main>
  );
}
