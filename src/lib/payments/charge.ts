/**
 * What to charge for a booking, derived ONLY from its server-computed snapshot
 * (spec §3). Never trust a client amount.
 *
 *   reservation_fee → the reservation fee (the show-up guarantee)
 *   cash_deposit    → the reservation fee too (deposit paid in cash at pickup,
 *                     but the fee still holds the car)
 *   full_deposit    → the full rental deposit, paid online instead of the fee
 */
import type { QuoteBreakdown } from "@/lib/booking/quote";

export type PaymentOption = "reservation_fee" | "full_deposit" | "cash_deposit";
export type ChargeType = "reservation_fee" | "deposit";

export interface Charge {
  type: ChargeType;
  amountCents: number;
  currency: string;
}

export function chargeForBooking(paymentOption: PaymentOption, breakdown: QuoteBreakdown): Charge {
  if (paymentOption === "full_deposit") {
    if (breakdown.depositCents === null || breakdown.depositCents <= 0) {
      throw new Error("full_deposit requires a positive deposit amount");
    }
    return { type: "deposit", amountCents: breakdown.depositCents, currency: breakdown.currency };
  }
  // reservation_fee and cash_deposit both charge the reservation fee online.
  if (breakdown.reservationFeeCents <= 0) {
    throw new Error("reservation fee must be positive to charge online");
  }
  return { type: "reservation_fee", amountCents: breakdown.reservationFeeCents, currency: breakdown.currency };
}
