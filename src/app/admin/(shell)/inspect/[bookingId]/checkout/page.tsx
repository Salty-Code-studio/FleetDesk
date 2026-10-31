"use client";

/**
 * Check-out wizard (spec W4). Reopens on the first open step and ends on a
 * finish screen that says what got done (Flow Desk phase 5). Return photos render SIDE-BY-SIDE with
 * the pickup photo of the same angle so new damage is obvious at a glance.
 * A return photo is only REQUIRED where the operator flags new damage: every
 * angle defaults to "same as pickup" (no photo needed); choosing "new damage"
 * reveals the note field and the upload control for that angle only.
 * The borg button records returned in full / partial / withheld; a reason is
 * required whenever anything is withheld.
 */
import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { apiGet, api, apiPut, type ApiError } from "@/app/admin/client";
import { useToast } from "@/app/admin/_ui";
import {
  checkoutProgress, checkoutResumeStep, checkoutFinishLines, type CheckoutFacts,
} from "@/lib/admin/wizard-progress";
import {
  ANGLES, PhotoCapture, FuelSelector, StepShell, FinishScreen, CheckList,
  capturePhoto, money, fileUrl, FUEL_LABELS,
  pendingReturnPhotoAngles,
  type Handover, type InspectionDto, type ReturnDamageChoice,
} from "../../wizard-ui";

const KICKER = "Check-out";

const factsOf = (h: Handover): CheckoutFacts => {
  const r = h.inspections.return;
  return {
    // A damage photo can be uploaded before step one saves its flags; photos
    // without flags mean the review was never saved, so resume on it.
    reviewSaved: r !== null && (r.damageFlags.length > 0 || r.photos.length === 0),
    odometer: r?.odometer ?? null,
    fuelLevel: r?.fuelLevel ?? null,
    borgReceivedCents: h.inspections.pickup?.borgReceivedCents ?? null,
    borgReturnedCents: r?.borgReturnedCents ?? null,
    keysReturned: !!r?.keysReturned,
  };
};

type DamageChoice = ReturnDamageChoice;

export default function CheckoutWizard() {
  const { bookingId } = useParams<{ bookingId: string }>();
  const router = useRouter();
  const toast = useToast();

  const [data, setData] = useState<Handover | null>(null);
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [odometer, setOdometer] = useState("");
  // Every angle defaults to "same as pickup" (no photo required); the operator
  // opts an angle INTO the photo requirement by marking it "new damage".
  const [choices, setChoices] = useState<Record<string, DamageChoice>>(() =>
    Object.fromEntries(ANGLES.map((a) => [a.id, "same" as DamageChoice])),
  );
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [borgChoice, setBorgChoice] = useState<"full" | "partial" | "withheld" | null>(null);
  const [partialReturned, setPartialReturned] = useState("");
  const [withheldReason, setWithheldReason] = useState("");
  const [doneLines, setDoneLines] = useState<string[] | null>(null);

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
        // Flags saved on an earlier visit come back as "new damage" choices,
        // so resuming past step one cannot silently drop them.
        const flagged = h.inspections.return?.damageFlags ?? [];
        if (flagged.length) {
          setChoices((cur) => {
            const next = { ...cur };
            for (const a of ANGLES) if (flagged.some((f) => f.note.startsWith(`${a.label}: `))) next[a.id] = "new";
            return next;
          });
          setNotes(Object.fromEntries(ANGLES.flatMap((a) => {
            const f = flagged.find((x) => x.note.startsWith(`${a.label}: `));
            return f ? [[a.id, f.note.slice(a.label.length + 2)]] : [];
          })));
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

  const pickupPhoto = (angle: string) => pickup?.photos.find((p) => p.label === angle)?.key ?? null;
  const returnPhoto = (angle: string) => ret?.photos.find((p) => p.label === angle)?.key ?? null;
  // Return photos are required ONLY for angles marked "new damage"; angles
  // left as "same as pickup" (the default) need none.
  const returnPhotosReady = useMemo(
    () => pendingReturnPhotoAngles(choices, (id) => !!returnPhoto(id)).length === 0,
    [choices, ret], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const setAnglePhoto = (angle: string) => async (file: File) => {
    const key = await capturePhoto(file, { category: "inspection", bookingId, kind: "return", label: angle });
    const photos = [...(ret?.photos ?? []).filter((p) => p.label !== angle), { key, label: angle }];
    await put({ photos });
  };

  if (!data) return <main className="wiz-page"><p className="wiz-sub">Loading booking...</p></main>;

  const b = data.booking;
  const received = pickup?.borgReceivedCents ?? null;
  const finished = b.status === "completed";
  const newDamageAngles = ANGLES.filter((a) => choices[a.id] === "new");
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
          kicker={KICKER} ring={ring} title="Return photos"
          onNext={guarded(async () => {
            for (const a of newDamageAngles) {
              if (!notes[a.id]?.trim()) throw new Error(`Add a note for the new damage on: ${a.label}`);
            }
            const damageFlags = newDamageAngles.map((a) => ({
              photoKey: returnPhoto(a.id) ?? "",
              note: `${a.label}: ${notes[a.id]!.trim()}`,
            }));
            await put({ damageFlags });
            setStep(2);
          })}
          nextDisabled={busy || !returnPhotosReady}
        >
          <p className="wiz-sub">Same six angles as pickup, for comparison. Mark each one same or new damage; a return photo is only required where you mark new damage.</p>
          {ANGLES.map((a) => (
            <div className="wiz-card" key={a.id}>
              <strong>{a.label}</strong>
              <div className="wiz-compare">
                <figure>
                  <figcaption>At pickup</figcaption>
                  {pickupPhoto(a.id)
                    ? <img src={fileUrl(pickupPhoto(a.id)!)} alt={`${a.label} at pickup`} />
                    : <div className="wiz-photo-empty">No pickup photo</div>}
                </figure>
                <figure>
                  <figcaption>Now</figcaption>
                  {returnPhoto(a.id)
                    ? <img src={fileUrl(returnPhoto(a.id)!)} alt={`${a.label} at return`} />
                    : <div className="wiz-photo-empty">{choices[a.id] === "new" ? "Not taken yet" : "No new damage"}</div>}
                </figure>
              </div>
              <div className="wiz-choice">
                <button type="button" className={choices[a.id] === "same" ? "on" : ""} onClick={() => setChoices({ ...choices, [a.id]: "same" })}>Same as pickup</button>
                <button type="button" className={choices[a.id] === "new" ? "on" : ""} onClick={() => setChoices({ ...choices, [a.id]: "new" })}>New damage</button>
              </div>
              {choices[a.id] === "new" ? (
                <>
                  <div style={{ height: 8 }} />
                  <textarea className="wiz-input" placeholder="Describe the new damage (required)" value={notes[a.id] ?? ""} onChange={(e) => setNotes({ ...notes, [a.id]: e.target.value })} />
                  <div style={{ height: 8 }} />
                  <PhotoCapture label={a.label} photoKey={returnPhoto(a.id)} onFile={setAnglePhoto(a.id)} />
                </>
              ) : null}
            </div>
          ))}
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
