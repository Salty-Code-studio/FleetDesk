import { describe, it, expect } from "vitest";
import { paidState } from "@/lib/admin/paid-state";

const base = {
  status: "picked_up",
  paidUntil: null as string | null,
  subtotalCents: 120_00,
  amountPaidCents: 0,
  currency: "USD",
  todayLocal: "2026-09-08",
};

describe("paidState: the amount branch", () => {
  it("flags an outstanding balance on a rental that is out", () => {
    const s = paidState(base);
    expect(s.unpaid).toBe(true);
    expect(s.balanceDueCents).toBe(120_00);
    expect(s.note).toBe("Unpaid: $120.00 still due");
  });

  it("clears once the balance is settled", () => {
    const s = paidState({ ...base, amountPaidCents: 120_00 });
    expect(s.unpaid).toBe(false);
    expect(s.balanceDueCents).toBe(0);
    expect(s.note).toBeNull();
  });

  it("also flags a COMPLETED rental that was never paid", () => {
    // The fork only checked picked_up, so an unpaid rental fell off the board
    // the moment the scooter came back — precisely the money the owner loses.
    const s = paidState({ ...base, status: "completed" });
    expect(s.unpaid).toBe(true);
  });

  it("never flags a booking that has not gone out yet", () => {
    expect(paidState({ ...base, status: "pending" }).unpaid).toBe(false);
    expect(paidState({ ...base, status: "confirmed" }).unpaid).toBe(false);
  });

  it("never flags a cancelled booking", () => {
    expect(paidState({ ...base, status: "cancelled" }).unpaid).toBe(false);
  });

  it("treats a zero-price booking as settled, not unpaid", () => {
    const s = paidState({ ...base, subtotalCents: 0 });
    expect(s.unpaid).toBe(false);
    expect(s.balanceDueCents).toBe(0);
  });

  it("never reports a negative balance after an over-credit", () => {
    const s = paidState({ ...base, amountPaidCents: 200_00 });
    expect(s.balanceDueCents).toBe(0);
    expect(s.unpaid).toBe(false);
  });
});

describe("paidState: the paid-until branch wins when set", () => {
  it("clears an unpaid balance when the desk marked a future date", () => {
    const s = paidState({ ...base, paidUntil: "2026-12-31" });
    expect(s.unpaid).toBe(false);
    expect(s.note).toBe("Paid until 2026-12-31");
  });

  it("flags a fully-paid balance when the marker has lapsed", () => {
    const s = paidState({ ...base, amountPaidCents: 120_00, paidUntil: "2026-08-31" });
    expect(s.unpaid).toBe(true);
    expect(s.note).toBe("Unpaid: paid until 2026-08-31");
  });

  it("treats today itself as still covered", () => {
    // "betaald t/m 8 september" means the 8th is paid for.
    const s = paidState({ ...base, paidUntil: "2026-09-08" });
    expect(s.unpaid).toBe(false);
  });
});

describe("paidState: currency", () => {
  it("prefixes a dollar sign for USD and names other currencies", () => {
    expect(paidState(base).note).toBe("Unpaid: $120.00 still due");
    expect(paidState({ ...base, currency: "AWG" }).note).toBe("Unpaid: AWG 120.00 still due");
  });
});
