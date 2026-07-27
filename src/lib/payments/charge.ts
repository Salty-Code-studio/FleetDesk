/**
 * What to charge for a booking, derived ONLY from its server-computed snapshot.
 * Never trust a client amount.
 *
 * The customer chooses ONE of two options:
 *   deposit -> pay max(depositPercent% of the rental total, depositMinCents) now
 *              (capped at the total), balance due at pickup
 *   full    -> pay the whole rental total now, nothing due at pickup
 *
 * The vehicle security deposit (borg, breakdown.depositCents) is NEVER charged
 * online; it is an at-pickup information line only.
 */
import type { QuoteBreakdown } from "@/lib/booking/quote";

export type PaymentOption = "deposit" | "full";

/** payments.type values. reservation_fee + deposit exist only on historical rows. */
export type ChargeType = "reservation_fee" | "deposit" | "rental_deposit" | "rental_full" | "extension";

export interface Charge {
  type: ChargeType;
  amountCents: number;
  currency: string;
}

export interface DepositSettings {
  depositPercent: number;
  depositMinCents: number;
}

export interface PaymentAmounts {
  payNowCents: number;
  balanceDueCents: number;
}

/** Deposit settings for amount math. Prefer the values snapshotted onto the
 *  breakdown at quote time; a pre-wave snapshot (no depositPercent) falls back
 *  to its old reservationFeeCents as a flat deposit (percent 0), so a legacy
 *  pending booking still charges exactly what its open session was created for. */
export function depositSettingsFromSnapshot(breakdown: QuoteBreakdown): DepositSettings {
  if (typeof breakdown.depositPercent === "number" && typeof breakdown.depositMinCents === "number") {
    return { depositPercent: breakdown.depositPercent, depositMinCents: breakdown.depositMinCents };
  }
  const legacy = breakdown as QuoteBreakdown & { reservationFeeCents?: number };
  return { depositPercent: 0, depositMinCents: legacy.reservationFeeCents ?? 0 };
}

/** Amount due now + balance at pickup for a chosen option. */
export function paymentAmounts(breakdown: QuoteBreakdown, option: PaymentOption, settings: DepositSettings): PaymentAmounts {
  const subtotal = breakdown.subtotalCents;
  if (option === "full") return { payNowCents: subtotal, balanceDueCents: 0 };
  const raw = Math.round((subtotal * settings.depositPercent) / 100);
  const payNow = Math.min(Math.max(raw, settings.depositMinCents), subtotal);
  return { payNowCents: payNow, balanceDueCents: subtotal - payNow };
}

export function chargeForBooking(paymentOption: PaymentOption, breakdown: QuoteBreakdown): Charge {
  const amounts = paymentAmounts(breakdown, paymentOption, depositSettingsFromSnapshot(breakdown));
  if (amounts.payNowCents <= 0) throw new Error("charge amount must be positive");
  return {
    type: paymentOption === "full" ? "rental_full" : "rental_deposit",
    amountCents: amounts.payNowCents,
    currency: breakdown.currency,
  };
}
