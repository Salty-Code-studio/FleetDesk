"use client";

/**
 * BookingDrawer section: check-in/out entry + the client-asked CHECKLIST
 * ("did we get X?" at a glance) + inspection detail (photos, meters, damage,
 * contract). Self-contained: fetches its own handover payload so the drawer
 * integration is two lines. Every toggle is ONE audited PUT (spec: audit per
 * toggle). Media renders same-origin via /api/admin/files (strict CSP).
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { apiGet, apiPut, type ApiError } from "@/app/admin/client";
import { useToast } from "@/app/admin/_ui";
import { fileUrl, money, FUEL_LABELS, type Handover, type InspectionDto } from "./inspect/wizard-ui";

function Toggle({ label, value, disabled, onTap }: {
  label: string; value: boolean; disabled?: boolean; onTap: () => void;
}) {
  return (
    <div className="wiz-check">
      <span>{label}</span>
      <button type="button" className="wiz-btn ghost" disabled={disabled} onClick={onTap} aria-pressed={value}>
        <span className={`state ${value ? "ok" : "todo"}`}>{value ? "yes" : "no"}</span>
      </button>
    </div>
  );
}

function InspectionDetail({ insp, currency }: { insp: InspectionDto; currency: string }) {
  return (
    <div className="wiz-card">
      <strong>{insp.kind === "pickup" ? "Check-in record" : "Check-out record"}</strong>
      <div className="wiz-row">
        <span className="muted">Odometer</span>
        <span>{insp.odometer ?? "not recorded"}</span>
      </div>
      <div className="wiz-row">
        <span className="muted">Fuel</span>
        <span>{insp.fuelLevel === null ? "not recorded" : FUEL_LABELS[insp.fuelLevel]}</span>
      </div>
      {insp.kind === "return" && insp.borgReturnedCents !== null ? (
        <div className="wiz-row">
          <span className="muted">Borg</span>
          <span>
            {money(insp.borgReturnedCents, currency)} returned
            {insp.borgWithheldCents ? `, ${money(insp.borgWithheldCents, currency)} withheld` : ""}
          </span>
        </div>
      ) : null}
      {insp.damageFlags.map((f) => (
        <div className="wiz-row" key={`${f.photoKey}-${f.note}`}>
          <span className="muted">Damage</span>
          <span>{f.note}</span>
        </div>
      ))}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6, marginTop: 8 }}>
        {insp.photos.map((p) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={p.key} src={fileUrl(p.key)} alt={p.label} title={p.label}
            style={{ width: "100%", height: 72, objectFit: "cover", borderRadius: 6, border: "1px solid #e3e6f0" }} />
        ))}
      </div>
      {insp.contractPdfKey ? (
        <p style={{ marginTop: 8 }}>
          <a href={fileUrl(insp.contractPdfKey)}>Download signed contract (PDF)</a>
        </p>
      ) : null}
    </div>
  );
}

export function InspectionPanel({ bookingId, onChanged }: { bookingId: string; onChanged?: () => void }) {
  const toast = useToast();
  const [data, setData] = useState<Handover | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = () =>
    apiGet<Handover>(`/api/admin/bookings/${bookingId}/handover`)
      .then(setData)
      .catch((e: ApiError) => toast.show({ type: "error", message: e.message }));

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookingId]);

  if (!data) return <p className="wiz-sub">Loading handover...</p>;

  const { booking, inspections } = data;
  const pickup = inspections.pickup;
  const ret = inspections.return;

  const toggle = (kind: "pickup" | "return", field: string, next: boolean) => async () => {
    if (busy) return;
    setBusy(true);
    try {
      await apiPut(`/api/admin/bookings/${bookingId}/inspection/${kind}`, { [field]: next });
      await reload();
      onChanged?.();
    } catch (e) {
      toast.show({ type: "error", message: (e as ApiError).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {booking.status === "pending" || booking.status === "confirmed" ? (
        <Link className="wiz-btn primary" style={{ display: "inline-flex", alignItems: "center", textDecoration: "none" }}
          href={`/admin/inspect/${bookingId}/checkin`}>
          Check in
        </Link>
      ) : null}
      {booking.status === "picked_up" ? (
        <Link className="wiz-btn primary" style={{ display: "inline-flex", alignItems: "center", textDecoration: "none" }}
          href={`/admin/inspect/${bookingId}/checkout`}>
          Check out
        </Link>
      ) : null}

      {booking.status !== "cancelled" ? (
        <div className="wiz-card" style={{ marginTop: 8 }}>
          <strong>Checklist</strong>
          <Toggle label="Agreement signed" value={!!pickup?.agreementSigned} disabled={busy}
            onTap={toggle("pickup", "agreementSigned", !pickup?.agreementSigned)} />
          <Toggle label="Rules signed" value={!!pickup?.rulesSigned} disabled={busy}
            onTap={toggle("pickup", "rulesSigned", !pickup?.rulesSigned)} />
          <Toggle label="Licence copy received" value={!!pickup?.licenseCopyReceived} disabled={busy}
            onTap={toggle("pickup", "licenseCopyReceived", !pickup?.licenseCopyReceived)} />
          <div className="wiz-check">
            <span>Borg received</span>
            <span className={`state ${pickup?.borgReceivedCents !== null && pickup?.borgReceivedCents !== undefined ? "ok" : "todo"}`}>
              {pickup?.borgReceivedCents !== null && pickup?.borgReceivedCents !== undefined
                ? money(pickup.borgReceivedCents, booking.currency)
                : "no"}
            </span>
          </div>
          {booking.status === "picked_up" || booking.status === "completed" ? (
            <Toggle label="Keys returned" value={!!ret?.keysReturned} disabled={busy}
              onTap={toggle("return", "keysReturned", !ret?.keysReturned)} />
          ) : null}
        </div>
      ) : null}

      {pickup && pickup.photos.length > 0 ? <InspectionDetail insp={pickup} currency={booking.currency} /> : null}
      {ret && ret.photos.length > 0 ? <InspectionDetail insp={ret} currency={booking.currency} /> : null}
    </div>
  );
}
