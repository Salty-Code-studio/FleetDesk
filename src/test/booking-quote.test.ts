import { describe, it, expect } from "vitest";
import { rentalDays, bestVehicleCents, quote } from "@/lib/booking/quote";

const rates = { priceDayCents: 5800, priceWeekCents: 34800, priceMonthCents: 118000, depositCents: 25000 };

describe("rentalDays", () => {
  it("counts whole days with an exclusive end", () => {
    expect(rentalDays("2026-07-01", "2026-07-08")).toBe(7);
    expect(rentalDays("2026-07-01", "2026-07-02")).toBe(1);
    expect(rentalDays("2026-07-01", "2026-08-01")).toBe(31);
  });
});

describe("bestVehicleCents — cheapest tier", () => {
  it("1 day = daily rate", () => {
    expect(bestVehicleCents(1, rates)).toBe(5800);
  });
  it("7 days = min(7·daily, weekly)", () => {
    // 7·5800 = 40600 vs weekly 34800 → weekly
    expect(bestVehicleCents(7, rates)).toBe(34800);
  });
  it("6 days is capped at the weekly rate when that is cheaper (round-up)", () => {
    // 6·5800 = 34800; weekly 34800 → equal; make weekly clearly cheaper to prove the cap
    const cheapWeek = { ...rates, priceWeekCents: 30000 };
    expect(bestVehicleCents(6, cheapWeek)).toBe(30000); // never pay more than a full week
  });
  it("30 days = monthly when cheapest", () => {
    // weeks: 4·34800 + 2·5800 = 150800; monthly 118000 → monthly
    expect(bestVehicleCents(30, rates)).toBe(118000);
  });
  it("10 days = week + 3 days, or cheaper", () => {
    // week 34800 + 3·5800 = 52200 ; all daily 58000 ; 2 weeks 69600 → 52200
    expect(bestVehicleCents(10, rates)).toBe(52200);
  });
  it("0 days = 0", () => {
    expect(bestVehicleCents(0, rates)).toBe(0);
  });
});

describe("quote", () => {
  it("sums vehicle + insurance + add-ons and passes through deposit/fee", () => {
    const b = quote({
      days: 7,
      vehicle: rates,
      insurance: { id: "ins1", name: "Premium", dailyPriceCents: 1500 },
      addOns: [
        { id: "a1", name: "Baby chair", priceCents: 500, pricing: "per_day", qty: 1 },
        { id: "a2", name: "Cooler", priceCents: 700, pricing: "per_rental", qty: 2 },
      ],
      reservationFeeCents: 3000,
      currency: "USD",
    });
    expect(b.vehicleCents).toBe(34800);          // weekly
    expect(b.insuranceCents).toBe(1500 * 7);     // 10500
    expect(b.addOns[0]!.cents).toBe(500 * 7);    // per_day ·7 = 3500
    expect(b.addOns[1]!.cents).toBe(700 * 2);    // per_rental ·2 = 1400
    expect(b.addOnsCents).toBe(3500 + 1400);     // 4900
    expect(b.subtotalCents).toBe(34800 + 10500 + 4900); // 50200
    expect(b.depositCents).toBe(25000);
    expect(b.reservationFeeCents).toBe(3000);
    expect(b.currency).toBe("USD");
  });

  it("handles no insurance and a null deposit", () => {
    const b = quote({ days: 3, vehicle: { ...rates, depositCents: null }, addOns: [], reservationFeeCents: 3000, currency: "USD" });
    expect(b.insuranceCents).toBe(0);
    expect(b.depositCents).toBeNull();
    expect(b.subtotalCents).toBe(b.vehicleCents);
  });
});
