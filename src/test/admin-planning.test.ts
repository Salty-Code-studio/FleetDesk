import { describe, it, expect, beforeAll } from "vitest";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { vehicles, customers, bookings } from "@/lib/db/schema";
import { dayRange, getPlanning } from "@/lib/admin/planning";
import { atAruba } from "@/lib/time/format";

let db: Awaited<ReturnType<typeof getDb>>;

beforeAll(async () => {
  db = await getDb();
  await runMigrations();
  const [eco] = await db.insert(vehicles).values({
    slug: "pl-eco", plate: "PL-pl-eco", class: "Economy", name: "Plan Eco", seats: 4, transmission: "Automatic",
    doors: 4, priceDayCents: 3500, priceWeekCents: 21000, priceMonthCents: 72000,
  }).returning();
  await db.insert(vehicles).values({
    slug: "pl-suv", plate: "PL-pl-suv", class: "SUV", name: "Plan SUV", seats: 5, transmission: "Automatic",
    doors: 5, priceDayCents: 5800, priceWeekCents: 34800, priceMonthCents: 118000,
  });
  await db.insert(vehicles).values({
    slug: "pl-retired", plate: "PL-pl-retired", class: "Van", name: "Retired Van", seats: 8, transmission: "Automatic",
    doors: 5, priceDayCents: 1, priceWeekCents: 1, priceMonthCents: 1, status: "retired",
  });
  const [c] = await db.insert(customers).values({ email: "plan@test.com", name: "Planner" }).returning();
  await db.insert(bookings).values({
    vehicleId: eco!.id, customerId: c!.id,
    startAt: atAruba("2027-03-05", "09:00"), endAt: atAruba("2027-03-09", "09:00"), bufferEndAt: atAruba("2027-03-10", "09:00"),
    status: "confirmed", priceBreakdown: {}, paymentOption: "reservation_fee", acceptedPolicyVersion: 1,
    acceptedAt: new Date(), idempotencyKey: "plan-1",
  });
});

describe("planning board data", () => {
  it("dayRange is inclusive of both ends", () => {
    expect(dayRange("2027-03-01", "2027-03-03")).toEqual(["2027-03-01", "2027-03-02", "2027-03-03"]);
  });

  it("groups vehicles by ordered category and excludes retired cars", async () => {
    const p = await getPlanning("2027-03-01", "2027-03-14");
    expect(p.days.length).toBe(14);
    expect(p.categories.map((c) => c.class)).toEqual(["Economy", "SUV"]); // Van(retired) excluded, ordered
    const eco = p.categories.find((c) => c.class === "Economy")!;
    expect(eco.vehicles[0]!.bookings.length).toBe(1);
    expect(eco.vehicles[0]!.bookings[0]!.label).toBe("Planner");
  });

  it("only includes bookings overlapping the window", async () => {
    const p = await getPlanning("2027-06-01", "2027-06-14"); // far from the March booking
    const totalBookings = p.categories.flatMap((c) => c.vehicles).flatMap((v) => v.bookings).length;
    expect(totalBookings).toBe(0);
  });
});
