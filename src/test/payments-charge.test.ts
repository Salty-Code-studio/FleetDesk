import { describe, it, expect } from "vitest";
import { chargeForBooking } from "@/lib/payments/charge";
import type { QuoteBreakdown } from "@/lib/booking/quote";

const breakdown: QuoteBreakdown = {
  days: 7, vehicleCents: 34800, insuranceCents: 0, addOns: [], addOnsCents: 0,
  subtotalCents: 34800, depositCents: 25000, reservationFeeCents: 3000, currency: "USD",
};

describe("chargeForBooking", () => {
  it("charges the reservation fee for reservation_fee", () => {
    expect(chargeForBooking("reservation_fee", breakdown)).toEqual({ type: "reservation_fee", amountCents: 3000, currency: "USD" });
  });
  it("charges the reservation fee for cash_deposit (fee still holds the car)", () => {
    expect(chargeForBooking("cash_deposit", breakdown)).toEqual({ type: "reservation_fee", amountCents: 3000, currency: "USD" });
  });
  it("charges the full deposit for full_deposit", () => {
    expect(chargeForBooking("full_deposit", breakdown)).toEqual({ type: "deposit", amountCents: 25000, currency: "USD" });
  });
  it("rejects full_deposit when no deposit is set", () => {
    expect(() => chargeForBooking("full_deposit", { ...breakdown, depositCents: null })).toThrow(/deposit/i);
  });
  it("rejects a non-positive reservation fee", () => {
    expect(() => chargeForBooking("reservation_fee", { ...breakdown, reservationFeeCents: 0 })).toThrow(/positive/i);
  });
});
