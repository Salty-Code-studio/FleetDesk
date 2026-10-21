import { describe, it, expect } from "vitest";
import { setupProgress, countCars, type SetupInput } from "@/lib/admin/setup-progress";

const zero: SetupInput = {
  alertRecipients: 0, activeCars: 0, carsWithDayRate: 0, carsWithDeposit: 0,
  activeTiers: 0, activeAddOns: 0, policiesPublished: 0,
  paymentsReady: true, activeStaff: 0, liveBookings: 0,
};
const full: SetupInput = {
  alertRecipients: 1, activeCars: 2, carsWithDayRate: 2, carsWithDeposit: 2,
  activeTiers: 1, activeAddOns: 1, policiesPublished: 3,
  paymentsReady: true, activeStaff: 1, liveBookings: 1,
};

describe("setupProgress", () => {
  it("all zero: only payments done, next is hours", () => {
    const p = setupProgress(zero);
    expect(p.done).toBe(1);
    expect(p.total).toBe(9);
    expect(p.next?.key).toBe("hours");
    expect(p.items.map((i) => i.key)).toEqual(
      ["hours", "rates", "deposits", "insurance", "addons", "policies", "payments", "team", "first"]);
  });
  it("zero active cars leaves rates and deposits open", () => {
    const p = setupProgress({ ...full, activeCars: 0, carsWithDayRate: 0, carsWithDeposit: 0 });
    const by = Object.fromEntries(p.items.map((i) => [i.key, i.done]));
    expect(by.rates).toBe(false);
    expect(by.deposits).toBe(false);
  });
  it("2 cars with 1 deposit leaves deposits open", () => {
    const p = setupProgress({ ...full, carsWithDeposit: 1 });
    expect(p.items.find((i) => i.key === "deposits")?.done).toBe(false);
    expect(p.items.find((i) => i.key === "rates")?.done).toBe(true);
  });
  it("everything set gives 100 and no next", () => {
    const p = setupProgress(full);
    expect(p.pct).toBe(100);
    expect(p.next).toBeNull();
  });
  it("pct for 6 of 9 is 67", () => {
    const p = setupProgress({ ...full, activeTiers: 0, activeAddOns: 0, liveBookings: 0 });
    expect(p.done).toBe(6);
    expect(p.pct).toBe(67);
  });
  it("payments item has no link", () => {
    expect(setupProgress(zero).items.find((i) => i.key === "payments")?.href).toBeNull();
  });
});

describe("countCars", () => {
  const car = (o: Partial<{ status: string; priceDayCents: number; depositCents: number | null }>) =>
    ({ status: "active", priceDayCents: 5000, depositCents: 10000, ...o });
  it("excludes retired cars", () => {
    expect(countCars([car({}), car({ status: "retired" })]).activeCars).toBe(1);
  });
  it("keeps maintenance cars active", () => {
    expect(countCars([car({ status: "maintenance" })]).activeCars).toBe(1);
  });
  it("does not count a 0 day rate", () => {
    expect(countCars([car({ priceDayCents: 0 })]).carsWithDayRate).toBe(0);
  });
  it("counts a 0 deposit as set", () => {
    expect(countCars([car({ depositCents: 0 })]).carsWithDeposit).toBe(1);
  });
  it("does not count a null deposit", () => {
    expect(countCars([car({ depositCents: null })]).carsWithDeposit).toBe(0);
  });
});
