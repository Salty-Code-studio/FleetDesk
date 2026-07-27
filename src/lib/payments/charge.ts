/**
 * What to charge for a booking, derived ONLY from its server-computed
 * snapshot. Never trust a client amount.
 *
 * The pure amount math (types + paymentAmounts + depositSettingsFromSnapshot)
 * lives in ./amounts (no server imports, safe for client components); this
 * module re-exports them so every existing import keeps working, and adds
 * chargeForBooking, which needs no server imports either but stays here to
 * keep the ChargeType/Charge shape colocated with its one caller's history.
 */
import type { QuoteBreakdown } from "@/lib/booking/quote";
import { paymentAmounts, depositSettingsFromSnapshot } from "./amounts";
import type { PaymentOption } from "./amounts";

export { paymentAmounts, depositSettingsFromSnapshot } from "./amounts";
export type { PaymentOption, PaymentAmounts, DepositSettings } from "./amounts";

/** payments.type values. reservation_fee + deposit exist only on historical rows. */
export type ChargeType = "reservation_fee" | "deposit" | "rental_deposit" | "rental_full" | "extension";

export interface Charge {
  type: ChargeType;
  amountCents: number;
  currency: string;
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
