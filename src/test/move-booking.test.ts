import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { vehicles, settings, customers, bookings } from "@/lib/db/schema";
import { moveBooking, cancelBookingAdmin } from "@/lib/admin/move-booking";
import { createManualBooking } from "@/lib/admin/manual-booking";
import { atAruba, parseTs } from "@/lib/time/format";
import { expectReject } from "./util";

let db: Awaited<ReturnType<typeof getDb>>;
let carA = "";
let carB = "";

const at = (d: string) => atAruba(d, "09:00");
/** Compare two timestamps by instant (the DB round-trips timestamptz in its own
 *  string representation, so a raw string equality would be brittle). */
const sameInstant = (a: string, d: string) => parseTs(a) === parseTs(at(d));

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
    const bk = await createManualBooking({ vehicleId: carA, startAt: at("2028-01-01"), endAt: at("2028-01-05"), customerName: "Shift" });
    const moved = await moveBooking(bk.id, { startAt: at("2028-01-10"), endAt: at("2028-01-14") });
    expect(sameInstant(moved.startAt, "2028-01-10")).toBe(true);
    expect(sameInstant(moved.endAt, "2028-01-14")).toBe(true);
    expect(moved.vehicleId).toBe(carA);
  });

  it("reassigns the booking to a different car", async () => {
    const bk = await createManualBooking({ vehicleId: carA, startAt: at("2028-02-01"), endAt: at("2028-02-05"), customerName: "Reassign" });
    const moved = await moveBooking(bk.id, { vehicleId: carB });
    expect(moved.vehicleId).toBe(carB);
    expect(sameInstant(moved.startAt, "2028-02-01")).toBe(true);
  });

  it("rejects a move that overlaps an existing booking on the target car (409)", async () => {
    // carB is occupied 2028-02-01..05 (buffer to 02-06) from the reassign test above
    const bk = await createManualBooking({ vehicleId: carA, startAt: at("2028-03-01"), endAt: at("2028-03-05"), customerName: "Clash" });
    await expectReject(
      moveBooking(bk.id, { vehicleId: carB, startAt: at("2028-02-02"), endAt: at("2028-02-04") }),
      /no longer|already|overlap|conflict|not available|reservation|taken/i,
    );
    // unchanged in the DB after the failed move
    const [after] = await db.select().from(bookings).where(eq(bookings.id, bk.id));
    expect(after!.vehicleId).toBe(carA);
    expect(sameInstant(after!.startAt, "2028-03-01")).toBe(true);
  });

  it("refuses to move a completed booking", async () => {
    const [c] = await db.insert(customers).values({ email: "done@test.com" }).returning();
    const [bk] = await db.insert(bookings).values({
      vehicleId: carA, customerId: c!.id, startAt: at("2028-04-01"), endAt: at("2028-04-05"), bufferEndAt: at("2028-04-06"),
      status: "completed", priceBreakdown: {}, paymentOption: "full",
      acceptedPolicyVersion: 0, acceptedAt: new Date(), idempotencyKey: "mv-done",
    }).returning();
    await expectReject(moveBooking(bk!.id, { startAt: at("2028-05-01"), endAt: at("2028-05-05") }), /no longer be moved/i);
  });

  it("rejects moving a terminal-status booking outright, without the advisory 'book anyway' override", async () => {
    // carA is occupied 2028-09-01..05 by an active booking, so a move into
    // this range trips checkAvailability's advisory conflict IF that check
    // runs before the movable-status gate.
    await createManualBooking({ vehicleId: carA, startAt: at("2028-09-01"), endAt: at("2028-09-05"), customerName: "Blocker" });
    const [c] = await db.insert(customers).values({ email: "cancelled-move@test.com" }).returning();
    const [bk] = await db.insert(bookings).values({
      vehicleId: carB, customerId: c!.id, startAt: at("2028-09-20"), endAt: at("2028-09-22"), bufferEndAt: at("2028-09-23"),
      status: "cancelled", priceBreakdown: {}, paymentOption: "full",
      acceptedPolicyVersion: 0, acceptedAt: new Date(), idempotencyKey: "mv-cancelled-blocked",
    }).returning();
    try {
      await moveBooking(bk!.id, { vehicleId: carA, startAt: at("2028-09-02"), endAt: at("2028-09-04") });
      throw new Error("expected moveBooking to reject");
    } catch (e) {
      const err = e as Error & { details?: { code?: string } };
      expect(err.message).toMatch(/no longer be moved/i);
      // The bug being regression-tested: a terminal-status booking must never
      // surface the advisory override offer, even into a blocked window.
      expect(err.message).not.toMatch(/book anyway/i);
      expect((err.details as { code?: string } | undefined)?.code).not.toBe("advisory_conflict");
    }
  });

  it("rejects a move onto a retired vehicle", async () => {
    const [ret] = await db.insert(vehicles).values({
      slug: "mv-ret", plate: "MV-RET", class: "Van", name: "Retired Mover", seats: 8, transmission: "Automatic",
      doors: 5, priceDayCents: 1, priceWeekCents: 1, priceMonthCents: 1, status: "retired",
    }).returning();
    const bk = await createManualBooking({ vehicleId: carA, startAt: at("2028-06-01"), endAt: at("2028-06-05"), customerName: "ToRetired" });
    await expectReject(moveBooking(bk.id, { vehicleId: ret!.id }), /not available/i);
  });
});

describe("cancelBookingAdmin", () => {
  it("cancels and frees the slot for a new booking on the same range", async () => {
    const bk = await createManualBooking({ vehicleId: carA, startAt: at("2028-07-01"), endAt: at("2028-07-05"), customerName: "Cancel Me" });
    const cancelled = await cancelBookingAdmin(bk.id, false, at("2028-06-01"));
    expect(cancelled.status).toBe("cancelled");
    // the freed range can be re-booked
    const reuse = await createManualBooking({ vehicleId: carA, startAt: at("2028-07-01"), endAt: at("2028-07-05"), customerName: "Reuse" });
    expect(reuse.id).toBeDefined();
  });

  it("refuses to cancel an already-cancelled booking", async () => {
    const bk = await createManualBooking({ vehicleId: carA, startAt: at("2028-08-01"), endAt: at("2028-08-05"), customerName: "Twice" });
    await cancelBookingAdmin(bk.id, false, at("2028-07-01"));
    await expectReject(cancelBookingAdmin(bk.id, false, at("2028-07-01")), /no longer be cancelled/i);
  });
});
