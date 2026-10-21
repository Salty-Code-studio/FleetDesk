"use client";

import { complianceBadges, rateLine } from "@/lib/admin/fleet-card";

export interface CardVehicle {
  id: string; plate: string; class: string; name: string;
  photos: string[];
  priceDayCents: number; priceWeekCents: number; priceMonthCents: number;
  status: "active" | "maintenance" | "retired";
  insuranceExpiresOn: string | null; inspectionDueOn: string | null;
  openNotes: number;
}

interface Props {
  v: CardVehicle;
  today: string;
  alertDays: number;
  onOpen: () => void;
  onEditRates: () => void;
}

/** One car: photo plane, plate, name and rates, ink chips. The card opens the car sheet. */
export function CarCard({ v, today, alertDays, onOpen, onEditRates }: Props) {
  const photo = v.photos[0];
  const badges = complianceBadges(v, today, alertDays);
  const retired = v.status === "retired";
  return (
    <article className={`fc-card ${retired ? "is-retired" : ""}`}>
      <button type="button" className="fc-card__open" onClick={onOpen} aria-label={`Open ${v.plate}, ${v.name}`} />
      <div
        className={`fc-card__photo ${photo ? "has-photo" : ""}`}
        style={photo ? { backgroundImage: `url("${photo.replace(/"/g, "%22")}")` } : undefined}
        aria-hidden="true"
      >
        <span className="fc-card__plate">{v.plate}</span>
      </div>
      <div className="fc-card__body">
        <div className="fc-card__name">{v.name}</div>
        <div className="fc-card__class">{v.class}</div>
        <div className="fc-card__rates">{rateLine(v, "$")}</div>
        <div className="fc-card__chips">
          {retired && <span className="fc-chip">Retired</span>}
          {v.status === "maintenance" && <span className="fc-chip fc-chip--amber">Maintenance</span>}
          {badges.map((b) => (
            <span key={b.key} className={`fc-chip ${b.overdue ? "fc-chip--danger" : "fc-chip--amber"}`}>{b.label}</span>
          ))}
          {v.openNotes > 0 && (
            <span className="fc-chip fc-chip--amber">{v.openNotes} open {v.openNotes === 1 ? "note" : "notes"}</span>
          )}
        </div>
      </div>
      <button type="button" className="fc-card__edit" onClick={onEditRates}>Edit rates</button>
    </article>
  );
}
