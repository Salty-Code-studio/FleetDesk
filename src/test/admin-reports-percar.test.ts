import { describe, it, expect, beforeAll } from "vitest";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { vehicles, customers, bookings, payments, adminUsers, inspections } from "@/lib/db/schema";
import { perCarRevenue, getReports } from "@/lib/admin/reports";

let db: Awaited<ReturnType<typeof getDb>>;
let ecoId: string, suvId: string, van1Id: string;
let customerId: string;
let adminId: string;

type BookingStatus = "pending" | "confirmed" | "picked_up" | "completed" | "cancelled";

/** Insert a booking with a snapshot subtotal. bufferEndAt = endAt is fine for
 *  the buffer check; seeded pending/confirmed/picked_up spans never overlap
 *  per vehicle, so the exclusion constraint stays quiet. */
async function addBooking(
  vehicleId: string, startAt: string, endAt: string,
  subtotalCents: number, status: BookingStatus, key: string,
) {
  const [row] = await db.insert(bookings).values({
    vehicleId, customerId,
    startAt, endAt, bufferEndAt: endAt,
    status, priceBreakdown: { subtotalCents }, paymentOption: "deposit",
    acceptedPolicyVersion: 1, acceptedAt: new Date(), idempotencyKey: key,
  }).returning();
  return row!;
}

const car = (slug: string, cls: string, name: string, status: "active" | "retired" = "active") => ({
  slug, plate: `RPT-${slug}`, class: cls, name, seats: 4, transmission: "Automatic",
  doors: 4, priceDayCents: 4000, priceWeekCents: 24000, priceMonthCents: 80000, status,
});

beforeAll(async () => {
  db = await getDb();
  await runMigrations();

  const [eco] = await db.insert(vehicles).values(car("eco", "Economy", "Report Eco")).returning();
  await db.insert(vehicles).values(car("cmp", "Compact", "Report Compact"));
  const [suv] = await db.insert(vehicles).values(car("suv", "SUV", "Report SUV")).returning();
  const [van1] = await db.insert(vehicles).values(car("van1", "Van", "Report Van", "retired")).returning();
  await db.insert(vehicles).values(car("van2", "Van", "Idle Retired Van", "retired"));
  ecoId = eco!.id; suvId = suv!.id; van1Id = van1!.id;

  const [c] = await db.insert(customers).values({ email: "reports@test.com", name: "Report Renter" }).returning();
  customerId = c!.id;
  const [admin] = await db.insert(adminUsers).values({ email: "reports-admin@test.com", passwordHash: "x" }).returning();
  adminId = admin!.id;

  // Economy: cross-month completed rental, a picked_up rental, and two rows
  // that must never count (pending, cancelled). Times are Aruba local (-04:00).
  const b1 = await addBooking(ecoId, "2026-03-28T09:00:00-04:00", "2026-04-04T09:00:00-04:00", 70000, "completed", "rpt-b1");
  const b2 = await addBooking(ecoId, "2026-06-10T09:00:00-04:00", "2026-06-13T09:00:00-04:00", 30000, "picked_up", "rpt-b2");
  await addBooking(ecoId, "2026-07-01T09:00:00-04:00", "2026-07-03T09:00:00-04:00", 99999, "pending", "rpt-b3");
  await addBooking(ecoId, "2026-08-01T09:00:00-04:00", "2026-08-03T09:00:00-04:00", 88888, "cancelled", "rpt-b4");

  // SUV: a rounding split, a rental spanning New Year, and a sub-24h rental.
  await addBooking(suvId, "2026-03-31T09:00:00-04:00", "2026-04-02T09:00:00-04:00", 1001, "completed", "rpt-b5");
  const b6 = await addBooking(suvId, "2025-12-30T09:00:00-04:00", "2026-01-03T09:00:00-04:00", 40000, "completed", "rpt-b6");
  await addBooking(suvId, "2026-06-20T09:00:00-04:00", "2026-06-20T12:00:00-04:00", 5000, "completed", "rpt-b7");

  // A retired car with in-year history stays visible in the report.
  await addBooking(van1Id, "2026-02-10T09:00:00-04:00", "2026-02-12T09:00:00-04:00", 15000, "completed", "rpt-b8");

  // A historical pre-wave security-deposit charge captured via Stripe.
  // Revenue math must never read payment rows, so this changes nothing.
  await db.insert(payments).values({
    bookingId: b1.id, type: "deposit", amountCents: 100000, status: "succeeded",
  });

  // Borg lifecycle from inspections. B1: 50000 held at pickup, 30000 returned
  // and 20000 withheld at return. B2: 50000 held. B6: held in 2025 (out of year).
  await db.insert(inspections).values({
    bookingId: b1.id, kind: "pickup", createdBy: adminId,
    createdAt: new Date("2026-03-28T14:00:00-04:00"),
    borgReceivedCents: 50000, photos: [], damageFlags: [],
  });
  await db.insert(inspections).values({
    bookingId: b1.id, kind: "return", createdBy: adminId,
    createdAt: new Date("2026-04-04T13:00:00-04:00"),
    borgReturnedCents: 30000, borgWithheldCents: 20000,
    borgWithheldReason: "Scratched rear bumper", photos: [], damageFlags: [],
  });
  await db.insert(inspections).values({
    bookingId: b2.id, kind: "pickup", createdBy: adminId,
    createdAt: new Date("2026-06-10T13:00:00-04:00"),
    borgReceivedCents: 50000, photos: [], damageFlags: [],
  });
  await db.insert(inspections).values({
    bookingId: b6.id, kind: "pickup", createdBy: adminId,
    createdAt: new Date("2025-12-30T13:00:00-04:00"),
    borgReceivedCents: 40000, photos: [], damageFlags: [],
  });
});

describe("perCarRevenue", () => {
  it("builds the 12 month keys of the requested year", async () => {
    const r = await perCarRevenue(2026);
    expect(r.year).toBe(2026);
    expect(r.months).toEqual([
      "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06",
      "2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12",
    ]);
  });

  it("slices a cross-month booking by overlap days and counts picked_up rentals", async () => {
    const r = await perCarRevenue(2026);
    const eco = r.rows.find((row) => row.plate === "RPT-eco")!;
    // Mar 28..31 = 4 of 7 days -> 40000; Apr 1..3 = 3 of 7 days -> 30000.
    // June: the picked_up rental, 3 fully-in-June days -> 30000.
    expect(eco.monthCents).toEqual([0, 0, 40000, 30000, 0, 30000, 0, 0, 0, 0, 0, 0]);
    // Pending, cancelled, and the deposit payment row never count.
    expect(eco.totalCents).toBe(100000);
  });

  it("allocates rounding without drift so cells sum exactly to the subtotal", async () => {
    const r = await perCarRevenue(2026);
    const suv = r.rows.find((row) => row.plate === "RPT-suv")!;
    expect(suv.monthCents[2]).toBe(501); // Mar: round(1001 x 1/2)
    expect(suv.monthCents[3]).toBe(500); // Apr: remainder; 501 + 500 = 1001
  });

  it("attributes only the in-year days of a booking that spans New Year", async () => {
    const r = await perCarRevenue(2026);
    const suv = r.rows.find((row) => row.plate === "RPT-suv")!;
    expect(suv.monthCents[0]).toBe(20000); // Jan 1 + Jan 2 of a 4 day rental at 40000
  });

  it("treats a sub-24h rental as one day", async () => {
    const r = await perCarRevenue(2026);
    const suv = r.rows.find((row) => row.plate === "RPT-suv")!;
    expect(suv.monthCents[5]).toBe(5000);
    expect(suv.totalCents).toBe(26001); // 20000 + 501 + 500 + 5000
  });

  it("groups rows by class order, keeps zero-revenue active cars, hides zero-revenue retired cars", async () => {
    const r = await perCarRevenue(2026);
    // Economy, Compact, SUV, Van; RPT-van2 (retired, no history) is hidden.
    expect(r.rows.map((row) => row.plate)).toEqual(["RPT-eco", "RPT-cmp", "RPT-suv", "RPT-van1"]);
    const cmp = r.rows.find((row) => row.plate === "RPT-cmp")!;
    expect(cmp.totalCents).toBe(0);
    expect(cmp.monthCents).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("sums row totals into the grand total", async () => {
    const r = await perCarRevenue(2026);
    expect(r.grandTotalCents).toBe(141001); // 100000 + 0 + 26001 + 15000
    expect(r.grandTotalCents).toBe(r.rows.reduce((s, row) => s + row.totalCents, 0));
  });

  it("reports borg held, returned, and withheld for the year, separate from revenue", async () => {
    const r = await perCarRevenue(2026);
    expect(r.borg.heldCents).toBe(100000); // the 2025 pickup is excluded
    expect(r.borg.returnedCents).toBe(30000);
    expect(r.borg.withheldCents).toBe(20000);
    expect(r.borg.withheldCount).toBe(1);
    expect(r.borg.withheldItems).toEqual([
      { plate: "RPT-eco", name: "Report Eco", amountCents: 20000, reason: "Scratched rear bumper" },
    ]);
  });

  it("returns zero rows and a zero borg summary for a year with no activity", async () => {
    const r = await perCarRevenue(2019);
    expect(r.rows.map((row) => row.plate)).toEqual(["RPT-eco", "RPT-cmp", "RPT-suv"]);
    expect(r.grandTotalCents).toBe(0);
    expect(r.borg).toEqual({ heldCents: 0, returnedCents: 0, withheldCents: 0, withheldCount: 0, withheldItems: [] });
  });
});

describe("getReports revenue statuses", () => {
  it("counts picked_up rentals in all-time revenue", async () => {
    const r = await getReports("2026-06-15");
    expect(r.kpis.revenueAllCents).toBe(161001); // 70000+30000+1001+40000+5000+15000
  });
});
