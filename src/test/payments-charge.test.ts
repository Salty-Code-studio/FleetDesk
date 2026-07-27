import { describe, it, expect } from "vitest";
import { paymentAmounts, chargeForBooking, depositSettingsFromSnapshot } from "@/lib/payments/charge";
import type { QuoteBreakdown } from "@/lib/booking/quote";

const breakdown: QuoteBreakdown = {
  days: 7, vehicleCents: 34800, insuranceCents: 0, addOns: [], addOnsCents: 0, youngDriverCents: 0,
  subtotalCents: 34800, depositCents: 25000, depositPercent: 25, depositMinCents: 3000, currency: "USD",
};

/** Strip the snapshot fields to simulate a pre-wave breakdown. */
function legacyBreakdown(reservationFeeCents: number): QuoteBreakdown {
  const legacy = { ...breakdown, reservationFeeCents } as QuoteBreakdown & { reservationFeeCents: number };
  delete (legacy as { depositPercent?: number }).depositPercent;
  delete (legacy as { depositMinCents?: number }).depositMinCents;
  return legacy;
}

describe("paymentAmounts", () => {
  it("deposit = percent of subtotal when above the floor", () => {
    expect(paymentAmounts(breakdown, "deposit", { depositPercent: 25, depositMinCents: 3000 }))
      .toEqual({ payNowCents: 8700, balanceDueCents: 26100 });
  });
  it("deposit floors at depositMinCents", () => {
    expect(paymentAmounts({ ...breakdown, subtotalCents: 4000 }, "deposit", { depositPercent: 25, depositMinCents: 3000 }))
      .toEqual({ payNowCents: 3000, balanceDueCents: 1000 });
  });
  it("deposit is capped at the subtotal", () => {
    expect(paymentAmounts({ ...breakdown, subtotalCents: 2000 }, "deposit", { depositPercent: 25, depositMinCents: 3000 }))
      .toEqual({ payNowCents: 2000, balanceDueCents: 0 });
  });
  it("full pays the whole subtotal with nothing due at pickup", () => {
    expect(paymentAmounts(breakdown, "full", { depositPercent: 25, depositMinCents: 3000 }))
      .toEqual({ payNowCents: 34800, balanceDueCents: 0 });
  });
});

describe("depositSettingsFromSnapshot", () => {
  it("prefers the snapshotted percent and floor", () => {
    expect(depositSettingsFromSnapshot(breakdown)).toEqual({ depositPercent: 25, depositMinCents: 3000 });
  });
  it("falls back to the legacy reservation fee as a flat deposit", () => {
    expect(depositSettingsFromSnapshot(legacyBreakdown(3000))).toEqual({ depositPercent: 0, depositMinCents: 3000 });
  });
});

describe("chargeForBooking", () => {
  it("deposit option charges the deposit as rental_deposit", () => {
    expect(chargeForBooking("deposit", breakdown)).toEqual({ type: "rental_deposit", amountCents: 8700, currency: "USD" });
  });
  it("full option charges the subtotal as rental_full", () => {
    expect(chargeForBooking("full", breakdown)).toEqual({ type: "rental_full", amountCents: 34800, currency: "USD" });
  });
  it("legacy snapshot charges the old flat reservation fee", () => {
    expect(chargeForBooking("deposit", legacyBreakdown(3000))).toEqual({ type: "rental_deposit", amountCents: 3000, currency: "USD" });
  });
  it("rejects a non-positive charge", () => {
    expect(() => chargeForBooking("deposit", { ...breakdown, subtotalCents: 0, depositPercent: 0, depositMinCents: 0 }))
      .toThrow(/positive/i);
  });
});
