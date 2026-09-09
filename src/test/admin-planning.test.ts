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
    status: "confirmed", priceBreakdown: {}, paymentOption: "deposit", acceptedPolicyVersion: 1,
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

describe("unpaid flag on the planning board", () => {
  it("flags an outstanding balance with NO paid-until marker", async () => {
    // Regression guard. The Little John fork read priceBreakdown.totalCents,
    // a key nothing in the codebase ever writes, so this branch never fired in
    // production. The fixture deliberately sets ONLY subtotalCents — the shape
    // the quote engine and manual bookings actually produce.
    const { eq } = await import("drizzle-orm");
    const [suv] = await db.select().from(vehicles).where(eq(vehicles.slug, "pl-suv"));
    const [c] = await db.insert(customers).values({ email: "unpaid-amount@test.com", name: "Owes Money" }).returning();

    await db.insert(bookings).values({
      vehicleId: suv!.id, customerId: c!.id,
      startAt: atAruba("2027-11-01", "09:00"), endAt: atAruba("2027-11-05", "17:00"), bufferEndAt: atAruba("2027-11-05", "19:00"),
      status: "picked_up",
      priceBreakdown: { subtotalCents: 24000, currency: "USD" },
      paymentOption: "full", amountPaidCents: 0, paidUntil: null,
      acceptedPolicyVersion: 1, acceptedAt: new Date(), idempotencyKey: "plan-unpaid-amount",
    }).returning();

    const p = await getPlanning("2027-11-01", "2027-11-14");
    const bar = p.categories.flatMap((cat) => cat.vehicles).flatMap((v) => v.bookings)
      .find((bk) => bk.label === "Owes Money")!;
    expect(bar.unpaid).toBe(true);
    expect(bar.balanceDueCents).toBe(24000);
    expect(bar.paidNote).toBe("Unpaid: $240.00 still due");
  });

  it("does not flag a rental that is fully settled", async () => {
    const { eq } = await import("drizzle-orm");
    const [suv] = await db.select().from(vehicles).where(eq(vehicles.slug, "pl-suv"));
    const [c] = await db.insert(customers).values({ email: "settled@test.com", name: "All Square" }).returning();

    await db.insert(bookings).values({
      vehicleId: suv!.id, customerId: c!.id,
      startAt: atAruba("2027-12-01", "09:00"), endAt: atAruba("2027-12-05", "17:00"), bufferEndAt: atAruba("2027-12-05", "19:00"),
      status: "picked_up",
      priceBreakdown: { subtotalCents: 24000, currency: "USD" },
      paymentOption: "full", amountPaidCents: 24000, paidUntil: null,
      acceptedPolicyVersion: 1, acceptedAt: new Date(), idempotencyKey: "plan-settled",
    });

    const p = await getPlanning("2027-12-01", "2027-12-14");
    const bar = p.categories.flatMap((cat) => cat.vehicles).flatMap((v) => v.bookings)
      .find((bk) => bk.label === "All Square")!;
    expect(bar.unpaid).toBe(false);
    expect(bar.paidNote).toBeNull();
  });

  it("flags a COMPLETED rental that was never settled", async () => {
    const { eq } = await import("drizzle-orm");
    const [suv] = await db.select().from(vehicles).where(eq(vehicles.slug, "pl-suv"));
    const [c] = await db.insert(customers).values({ email: "walked-off@test.com", name: "Walked Off" }).returning();

    await db.insert(bookings).values({
      vehicleId: suv!.id, customerId: c!.id,
      startAt: atAruba("2028-01-05", "09:00"), endAt: atAruba("2028-01-09", "17:00"), bufferEndAt: atAruba("2028-01-09", "19:00"),
      status: "completed",
      priceBreakdown: { subtotalCents: 30000, currency: "USD" },
      paymentOption: "full", amountPaidCents: 0, paidUntil: null,
      acceptedPolicyVersion: 1, acceptedAt: new Date(), idempotencyKey: "plan-completed-unpaid",
    });

    const p = await getPlanning("2028-01-05", "2028-01-18");
    const bar = p.categories.flatMap((cat) => cat.vehicles).flatMap((v) => v.bookings)
      .find((bk) => bk.label === "Walked Off")!;
    expect(bar.unpaid).toBe(true);
  });

  it("lets a future paid-until marker override an outstanding balance", async () => {
    const { eq } = await import("drizzle-orm");
    const [suv] = await db.select().from(vehicles).where(eq(vehicles.slug, "pl-suv"));
    const [c] = await db.insert(customers).values({ email: "monthly@test.com", name: "Monthly Renter" }).returning();

    await db.insert(bookings).values({
      vehicleId: suv!.id, customerId: c!.id,
      startAt: atAruba("2028-02-01", "09:00"), endAt: atAruba("2028-07-31", "17:00"), bufferEndAt: atAruba("2028-07-31", "19:00"),
      status: "picked_up",
      priceBreakdown: { subtotalCents: 180000, currency: "USD" },
      paymentOption: "full", amountPaidCents: 0, paidUntil: "2099-01-01",
      acceptedPolicyVersion: 1, acceptedAt: new Date(), idempotencyKey: "plan-marker-future",
    });

    const p = await getPlanning("2028-02-01", "2028-02-14");
    const bar = p.categories.flatMap((cat) => cat.vehicles).flatMap((v) => v.bookings)
      .find((bk) => bk.label === "Monthly Renter")!;
    expect(bar.unpaid).toBe(false);
    expect(bar.paidUntil).toBe("2099-01-01");
    expect(bar.paidNote).toBe("Paid until 2099-01-01");
  });

  it("lets a lapsed paid-until marker override a settled balance", async () => {
    const { eq } = await import("drizzle-orm");
    const [suv] = await db.select().from(vehicles).where(eq(vehicles.slug, "pl-suv"));
    const [c] = await db.insert(customers).values({ email: "lapsed@test.com", name: "Lapsed Renter" }).returning();

    await db.insert(bookings).values({
      vehicleId: suv!.id, customerId: c!.id,
      startAt: atAruba("2028-08-01", "09:00"), endAt: atAruba("2029-01-31", "17:00"), bufferEndAt: atAruba("2029-01-31", "19:00"),
      status: "picked_up",
      priceBreakdown: { subtotalCents: 180000, currency: "USD" },
      paymentOption: "full", amountPaidCents: 180000, paidUntil: "2020-01-01",
      acceptedPolicyVersion: 1, acceptedAt: new Date(), idempotencyKey: "plan-marker-lapsed",
    });

    const p = await getPlanning("2028-08-01", "2028-08-14");
    const bar = p.categories.flatMap((cat) => cat.vehicles).flatMap((v) => v.bookings)
      .find((bk) => bk.label === "Lapsed Renter")!;
    expect(bar.unpaid).toBe(true);
    expect(bar.paidNote).toBe("Unpaid: paid until 2020-01-01");
  });
});
