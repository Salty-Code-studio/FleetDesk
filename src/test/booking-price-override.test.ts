import { describe, it, expect } from "vitest";
import { applyPriceOverride, originalSubtotalCents } from "@/lib/booking/price-override";

const quoted = {
  days: 4,
  vehicleCents: 40000,
  insuranceCents: 5000,
  addOns: [{ id: "a1", name: "Helmet", qty: 1, cents: 1000 }],
  addOnsCents: 1000,
  subtotalCents: 46000,
  currency: "USD",
};
const meta = { reason: "settled against key work", byAdminId: "admin-1", at: "2026-09-08T12:00:00.000Z" };

describe("applyPriceOverride", () => {
  it("rewrites the subtotal and records a signed adjustment", () => {
    const out = applyPriceOverride(quoted, 38000, meta);
    expect(out.subtotalCents).toBe(38000);
    expect(out.adjustmentCents).toBe(-8000);
  });

  it("records a positive adjustment when the price goes up", () => {
    const out = applyPriceOverride(quoted, 50000, meta);
    expect(out.adjustmentCents).toBe(4000);
  });

  it("leaves every original line item untouched so the contract still itemises", () => {
    const out = applyPriceOverride(quoted, 38000, meta);
    expect(out.days).toBe(4);
    expect(out.vehicleCents).toBe(40000);
    expect(out.insuranceCents).toBe(5000);
    expect(out.addOns).toEqual(quoted.addOns);
    expect(out.currency).toBe("USD");
  });

  it("makes the lines plus the adjustment add back up to the new total", () => {
    const out = applyPriceOverride(quoted, 38000, meta);
    const lines = (out.vehicleCents as number) + (out.insuranceCents as number)
      + (out.addOnsCents as number) + (out.adjustmentCents as number);
    expect(lines).toBe(out.subtotalCents);
  });

  it("stamps who, why and when", () => {
    const out = applyPriceOverride(quoted, 38000, meta);
    expect(out.priceOverride).toEqual({
      previousSubtotalCents: 46000,
      reason: "settled against key work",
      byAdminId: "admin-1",
      at: "2026-09-08T12:00:00.000Z",
    });
  });

  it("measures a REPEATED override against the original quote, not the last edit", () => {
    // Otherwise the adjustment line drifts: 46000 → 38000 → 40000 would record
    // +2000 and the contract lines would stop adding up to the total.
    const once = applyPriceOverride(quoted, 38000, meta);
    const twice = applyPriceOverride(once, 40000, { ...meta, reason: "corrected", at: "2026-09-09T09:00:00.000Z" });
    expect(twice.subtotalCents).toBe(40000);
    expect(twice.adjustmentCents).toBe(-6000);
    expect(twice.priceOverride!.previousSubtotalCents).toBe(46000);
    expect(twice.priceOverride!.reason).toBe("corrected");
  });

  it("does not mutate the breakdown it was given", () => {
    const input = { ...quoted };
    applyPriceOverride(input, 38000, meta);
    expect(input.subtotalCents).toBe(46000);
    expect("adjustmentCents" in input).toBe(false);
  });

  it("handles the degenerate manual-booking shape", () => {
    const out = applyPriceOverride({ manual: true, subtotalCents: 0, currency: "USD" }, 12000, meta);
    expect(out.subtotalCents).toBe(12000);
    expect(out.adjustmentCents).toBe(12000);
    expect(out.manual).toBe(true);
  });
});

describe("originalSubtotalCents", () => {
  it("returns the current subtotal when never overridden", () => {
    expect(originalSubtotalCents(quoted)).toBe(46000);
  });

  it("returns the pre-override subtotal once overridden", () => {
    expect(originalSubtotalCents(applyPriceOverride(quoted, 38000, meta))).toBe(46000);
  });

  it("treats a missing subtotal as zero", () => {
    expect(originalSubtotalCents({})).toBe(0);
  });
});
