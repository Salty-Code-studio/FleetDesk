import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { vehicles, settings, customers, bookings } from "@/lib/db/schema";
import { moveBooking, cancelBookingAdmin } from "@/lib/admin/move-booking";
import { createManualBooking } from "@/lib/admin/manual-booking";
import { expectReject } from "./util";

let db: Awaited<ReturnType<typeof getDb>>;
let carA = "";
let carB = "";

beforeAll(async () => {
  db = await getDb();
  await runMigrations();
  await db.insert(settings).values({ id: 1 }).onConflictDoNothing();
  const [a] = await db.insert(vehicles).values({
    slug: "mv-a", plate: "MV-A", class: "SUV", name: "Mover A", seats: 5, transmission: "Automatic",
    doors: 5, priceDayCents: 5800, priceWeekCents: 34800, priceMonthCents: 118000,
  }).returning();
  const [b] = await db.insert(vehicles).values({
    slug: "mv-b", plate: "MV-B", class: "SUV", name: "Mover B", seats: 5, transmission: "Automatic",
    doors: 5, priceDayCents: 6500, priceWeekCents: 39000, priceMonthCents: 132000,
  }).returning();
  carA = a!.id; carB = b!.id;
});

describe("moveBooking", () => {
  it("shifts the dates on the same vehicle", async () => {
    const bk = await createManualBooking({ vehicleId: carA, startDate: "2028-01-01", endDate: "2028-01-05", customerName: "Shift" });
    const moved = await moveBooking(bk.id, { startDate: "2028-01-10", endDate: "2028-01-14" });
    expect(moved.startDate).toBe("2028-01-10");
    expect(moved.endDate).toBe("2028-01-14");
    expect(moved.vehicleId).toBe(carA);
  });

  it("reassigns the booking to a different car", async () => {
    const bk = await createManualBooking({ vehicleId: carA, startDate: "2028-02-01", endDate: "2028-02-05", customerName: "Reassign" });
    const moved = await moveBooking(bk.id, { vehicleId: carB });
    expect(moved.vehicleId).toBe(carB);
    expect(moved.startDate).toBe("2028-02-01");
  });

  it("rejects a move that overlaps an existing booking on the target car (409)", async () => {
    // carB is occupied 2028-02-01..05 (buffer to 02-06) from the reassign test above
    const bk = await createManualBooking({ vehicleId: carA, startDate: "2028-03-01", endDate: "2028-03-05", customerName: "Clash" });
    await expectReject(
      moveBooking(bk.id, { vehicleId: carB, startDate: "2028-02-02", endDate: "2028-02-04" }),
      /no longer|already|overlap|conflict|not available|reservation|taken/i,
    );
    // unchanged in the DB after the failed move
    const [after] = await db.select().from(bookings).where(eq(bookings.id, bk.id));
    expect(after!.vehicleId).toBe(carA);
    expect(after!.startDate).toBe("2028-03-01");
  });

  it("refuses to move a completed booking", async () => {
    const [c] = await db.insert(customers).values({ email: "done@test.com" }).returning();
    const [bk] = await db.insert(bookings).values({
      vehicleId: carA, customerId: c!.id, startDate: "2028-04-01", endDate: "2028-04-05", bufferEndDate: "2028-04-06",
      status: "completed", priceBreakdown: {}, paymentOption: "cash_deposit",
      acceptedPolicyVersion: 0, acceptedAt: new Date(), idempotencyKey: "mv-done",
    }).returning();
    await expectReject(moveBooking(bk!.id, { startDate: "2028-05-01", endDate: "2028-05-05" }), /no longer be moved/i);
  });

  it("rejects a move onto a retired vehicle", async () => {
    const [ret] = await db.insert(vehicles).values({
      slug: "mv-ret", plate: "MV-RET", class: "Van", name: "Retired Mover", seats: 8, transmission: "Automatic",
      doors: 5, priceDayCents: 1, priceWeekCents: 1, priceMonthCents: 1, status: "retired",
    }).returning();
    const bk = await createManualBooking({ vehicleId: carA, startDate: "2028-06-01", endDate: "2028-06-05", customerName: "ToRetired" });
    await expectReject(moveBooking(bk.id, { vehicleId: ret!.id }), /not available/i);
  });
});

describe("cancelBookingAdmin", () => {
  it("cancels and frees the slot for a new booking on the same range", async () => {
    const bk = await createManualBooking({ vehicleId: carA, startDate: "2028-07-01", endDate: "2028-07-05", customerName: "Cancel Me" });
    const cancelled = await cancelBookingAdmin(bk.id);
    expect(cancelled.status).toBe("cancelled");
    // the freed range can be re-booked
    const reuse = await createManualBooking({ vehicleId: carA, startDate: "2028-07-01", endDate: "2028-07-05", customerName: "Reuse" });
    expect(reuse.id).toBeDefined();
  });

  it("refuses to cancel an already-cancelled booking", async () => {
    const bk = await createManualBooking({ vehicleId: carA, startDate: "2028-08-01", endDate: "2028-08-05", customerName: "Twice" });
    await cancelBookingAdmin(bk.id);
    await expectReject(cancelBookingAdmin(bk.id), /no longer be cancelled/i);
  });
});
