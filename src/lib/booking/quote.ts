/**
 * Server-side price computation (spec §3, §6: the total is ALWAYS computed here,
 * never trusted from the client, and snapshotted onto the booking).
 *
 * Pricing is tiered (daily / weekly / monthly) and we always charge the CHEAPEST
 * decomposition, so "the longer you keep it, the more you save" holds and a
 * short rental is never charged more than the next tier up. We compute the exact
 * optimum with a tiny DP over the day count.
 */
import { parseTs } from "@/lib/time/format";

export interface VehicleRates {
  priceDayCents: number;
  priceWeekCents: number;
  priceMonthCents: number;
  depositCents: number | null;
}

export interface QuoteAddOnInput {
  id: string;
  name: string;
  priceCents: number;
  pricing: "per_day" | "per_rental";
  qty: number;
}

export interface QuoteInput {
  days: number;
  vehicle: VehicleRates;
  insurance?: { id: string; name: string; dailyPriceCents: number } | null;
  addOns: QuoteAddOnInput[];
  reservationFeeCents: number;
  currency: string;
}

export interface QuoteAddOnLine {
  id: string;
  name: string;
  qty: number;
  cents: number;
}

export interface QuoteBreakdown {
  days: number;
  vehicleCents: number;
  insuranceCents: number;
  addOns: QuoteAddOnLine[];
  addOnsCents: number;
  /** Rental total owed (vehicle + insurance + add-ons). */
  subtotalCents: number;
  /** Refundable security hold; null until the owner sets a per-class deposit. */
  depositCents: number | null;
  /** Upfront amount that locks the booking. */
  reservationFeeCents: number;
  currency: string;
}

/** Whole charged rental days from timestamps: ceil of elapsed hours / 24, min 1.
 *  09:00 -> 09:00 next day = 1 day; any overrun starts the next day. */
export function rentalDays(startAt: string, endAt: string): number {
  const hours = (parseTs(endAt) - parseTs(startAt)) / 3_600_000;
  return Math.max(1, Math.ceil(hours / 24));
}

/** Cheapest tiered price for `days` days. cost[0]=0; each day extends from the
 *  best of: +1 day, +1 week (covers up to 7), +1 month (covers up to 30). */
export function bestVehicleCents(days: number, r: VehicleRates): number {
  if (days <= 0) return 0;
  const cost = new Array<number>(days + 1).fill(Number.POSITIVE_INFINITY);
  cost[0] = 0;
  for (let n = 1; n <= days; n++) {
    cost[n] = Math.min(
      cost[n - 1]! + r.priceDayCents,
      cost[Math.max(0, n - 7)]! + r.priceWeekCents,
      cost[Math.max(0, n - 30)]! + r.priceMonthCents,
    );
  }
  return cost[days]!;
}

export function quote(input: QuoteInput): QuoteBreakdown {
  const { days, vehicle, insurance, addOns, reservationFeeCents, currency } = input;
  const vehicleCents = bestVehicleCents(days, vehicle);
  const insuranceCents = insurance ? insurance.dailyPriceCents * days : 0;

  const addOnLines: QuoteAddOnLine[] = addOns.map((a) => ({
    id: a.id,
    name: a.name,
    qty: a.qty,
    cents: a.pricing === "per_day" ? a.priceCents * days * a.qty : a.priceCents * a.qty,
  }));
  const addOnsCents = addOnLines.reduce((sum, l) => sum + l.cents, 0);

  return {
    days,
    vehicleCents,
    insuranceCents,
    addOns: addOnLines,
    addOnsCents,
    subtotalCents: vehicleCents + insuranceCents + addOnsCents,
    depositCents: vehicle.depositCents,
    reservationFeeCents,
    currency,
  };
}
