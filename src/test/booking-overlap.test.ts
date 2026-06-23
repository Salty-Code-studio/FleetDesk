import { describe, it, expect, beforeAll } from "vitest";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { vehicles, customers, bookings } from "@/lib/db/schema";
import { expectReject } from "./util";

let db: Awaited<ReturnType<typeof getDb>>;
let vehicleId = "";
let otherVehicleId = "";
let customerId = "";

const mkBooking = (
  start: string,
  end: string,
  key: string,
  status: "pending" | "confirmed" | "cancelled" | "completed" = "confirmed",
  forVehicleId?: string,
  bufferEnd?: string,
) => ({
  vehicleId: forVehicleId ?? vehicleId,
  customerId, startDate: start, endDate: end, bufferEndDate: bufferEnd ?? end, status,
  priceBreakdown: { totalCents: 10000 },
  paymentOption: "reservation_fee" as const,
  acceptedPolicyVersion: 1,
  acceptedAt: new Date(),
  idempotencyKey: key,
});

beforeAll(async () => {
  db = await getDb();
  await runMigrations();
  const [v] = await db.insert(vehicles).values({
    slug: "test-car", plate: "PL-test-car", class: "SUV", name: "Test Car", seats: 5, transmission: "Automatic",
    doors: 5, priceDayCents: 5800, priceWeekCents: 34800, priceMonthCents: 118000,
  }).returning({ id: vehicles.id });
  const [v2] = await db.insert(vehicles).values({
    slug: "test-car-2", plate: "PL-test-car-2", class: "SUV", name: "Test Car 2", seats: 5, transmission: "Automatic",
    doors: 5, priceDayCents: 6500, priceWeekCents: 39000, priceMonthCents: 132000,
  }).returning({ id: vehicles.id });
  const [c] = await db.insert(customers).values({ email: "t@t.com" }).returning({ id: customers.id });
  vehicleId = v!.id;
  otherVehicleId = v2!.id;
  customerId = c!.id;
});

describe("bookings_no_overlap exclusion constraint", () => {
  it("accepts a booking", async () => {
    await expect(db.insert(bookings).values(mkBooking("2026-07-01", "2026-07-08", "k1"))).resolves.toBeDefined();
  });

  it("physically rejects an overlapping booking for the same vehicle", async () => {
    await expectReject(
      db.insert(bookings).values(mkBooking("2026-07-05", "2026-07-10", "k2")),
      /bookings_no_overlap|exclusion/i,
    );
  });

  it("allows back-to-back ranges (exclusive end date)", async () => {
    await expect(db.insert(bookings).values(mkBooking("2026-07-08", "2026-07-12", "k3"))).resolves.toBeDefined();
  });

  it("a pending booking also blocks the range", async () => {
    await db.insert(bookings).values(mkBooking("2026-08-10", "2026-08-15", "k-pending", "pending"));
    await expectReject(
      db.insert(bookings).values(mkBooking("2026-08-12", "2026-08-20", "k-clash")),
      /bookings_no_overlap|exclusion/i,
    );
  });

  it("the SAME dates on a DIFFERENT vehicle are fine (constraint is per-vehicle)", async () => {
    // Guards against an over-broad constraint that forgot `vehicle_id WITH =`:
    // this exact overlap on vehicle 1 is rejected above, so it must succeed on vehicle 2.
    await expect(
      db.insert(bookings).values(mkBooking("2026-07-05", "2026-07-10", "k-other-vehicle", "confirmed", otherVehicleId)),
    ).resolves.toBeDefined();
  });

  it("a cancelled booking frees its range", async () => {
    await db.insert(bookings).values(mkBooking("2026-08-01", "2026-08-05", "k4", "cancelled"));
    await expect(db.insert(bookings).values(mkBooking("2026-08-01", "2026-08-05", "k5"))).resolves.toBeDefined();
  });

  it("a completed booking frees its range (post-return re-rental)", async () => {
    await db.insert(bookings).values(mkBooking("2026-11-01", "2026-11-05", "k-done", "completed"));
    await expect(db.insert(bookings).values(mkBooking("2026-11-01", "2026-11-05", "k-rerent"))).resolves.toBeDefined();
  });

  it("rejects duplicate idempotency keys", async () => {
    await expectReject(
      db.insert(bookings).values(mkBooking("2026-09-01", "2026-09-05", "k5")),
      /unique|duplicate/i,
    );
  });

  it("rejects end <= start", async () => {
    await expectReject(
      db.insert(bookings).values(mkBooking("2026-10-05", "2026-10-05", "k6")),
      /bookings_dates|check/i,
    );
  });

  it("the exclusion constraint enforces the turnaround buffer (DB-level, not just app)", async () => {
    // booking with a 1-day buffer: occupies [2026-12-01, 2026-12-06) for cleaning
    await db.insert(bookings).values(mkBooking("2026-12-01", "2026-12-05", "buf-1", "confirmed", undefined, "2026-12-06"));
    // a new booking starting on the buffer day (12-05) clashes at the DB level
    await expectReject(
      db.insert(bookings).values(mkBooking("2026-12-05", "2026-12-09", "buf-2", "confirmed", undefined, "2026-12-10")),
      /bookings_no_overlap|exclusion/i,
    );
    // starting after the cleaning gap (12-06) is allowed
    await expect(
      db.insert(bookings).values(mkBooking("2026-12-06", "2026-12-09", "buf-3", "confirmed", undefined, "2026-12-10")),
    ).resolves.toBeDefined();
  });
});
