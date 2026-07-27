/**
 * Pure money-math types + functions for what to charge a booking, derived
 * ONLY from its server-computed snapshot. Never trust a client amount.
 *
 * The customer chooses ONE of two options:
 *   deposit -> pay max(depositPercent% of the rental total, depositMinCents) now
 *              (capped at the total), balance due at pickup
 *   full    -> pay the whole rental total now, nothing due at pickup
 *
 * The vehicle security deposit (borg, breakdown.depositCents) is NEVER charged
 * online; it is an at-pickup information line only.
 *
 * No server imports here (no db, no Stripe) — safe to import from client
 * components (e.g. the booking wizard).
 */
import type { QuoteBreakdown } from "@/lib/booking/quote";

export type PaymentOption = "deposit" | "full";

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
