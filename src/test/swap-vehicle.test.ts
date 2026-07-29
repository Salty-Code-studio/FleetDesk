import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { vehicles, settings, customers, bookings, availabilityBlocks } from "@/lib/db/schema";
import { swapVehicle } from "@/lib/admin/swap-vehicle";
import { createManualBooking } from "@/lib/admin/manual-booking";
import { atAruba, parseTs } from "@/lib/time/format";
import { expectReject } from "./util";

let db: Awaited<ReturnType<typeof getDb>>;
let carA = ""; // 5800/day
let carB = ""; // 6500/day — different rate, used for price-preservation + clash
let carC = ""; // 7000/day — kept clash-free, used for the advisory-block override
let retired = "";

const at = (d: string) => atAruba(d, "09:00");
const sameInstant = (a: string, d: string) => parseTs(a) === parseTs(at(d));

/** Insert a booking row directly so a test can pin status / source / price. */
async function seedBooking(opts: {
  vehicleId: string; start: string; end: string;
  status?: "pending" | "confirmed" | "picked_up" | "cancelled" | "completed";
  source?: "online" | "manual";
  price?: unknown;
  key: string;
}) {
  const [c] = await db.insert(customers).values({ email: `${opts.key}@test.com` }).returning();
  const bufferEnd = new Date(parseTs(at(opts.end)) + 86_400_000).toISOString();
  const [bk] = await db.insert(bookings).values({
    vehicleId: opts.vehicleId, customerId: c!.id,
    startAt: at(opts.start), endAt: at(opts.end), bufferEndAt: bufferEnd,
    status: opts.status ?? "confirmed", source: opts.source ?? "online",
    priceBreakdown: opts.price ?? {}, paymentOption: "full",
    acceptedPolicyVersion: 0, acceptedAt: new Date(), idempotencyKey: opts.key,
  }).returning();
  return bk!;
}

beforeAll(async () => {
  db = await getDb();
  await runMigrations();
  await db.insert(settings).values({ id: 1 }).onConflictDoNothing();
  const mk = async (slug: string, day: number, status: "active" | "retired" = "active") => {
    const [v] = await db.insert(vehicles).values({
      slug, plate: slug.toUpperCase(), class: "SUV", name: slug, seats: 5, transmission: "Automatic",
      doors: 5, priceDayCents: day, priceWeekCents: day * 6, priceMonthCents: day * 20, status,
    }).returning();
    return v!.id;
  };
  carA = await mk("sw-a", 5800);
  carB = await mk("sw-b", 6500);
  carC = await mk("sw-c", 7000);
  retired = await mk("sw-ret", 1, "retired");
});

describe("swapVehicle", () => {
  it("reassigns a confirmed booking to another car, leaving dates, status and price untouched", async () => {
    const bk = await createManualBooking({ vehicleId: carA, startAt: at("2029-01-01"), endAt: at("2029-01-05"), customerName: "Confirmed" });
    const priceBefore = bk.priceBreakdown;
    const swapped = await swapVehicle(bk.id, { vehicleId: carB });
    expect(swapped.vehicleId).toBe(carB);
    expect(sameInstant(swapped.startAt, "2029-01-01")).toBe(true);
    expect(sameInstant(swapped.endAt, "2029-01-05")).toBe(true);
    expect(swapped.status).toBe("confirmed");
    expect(swapped.priceBreakdown).toEqual(priceBefore);
  });

  it("swaps a picked-up booking and keeps it picked_up (the customer still has a car)", async () => {
    const bk = await seedBooking({ vehicleId: carA, start: "2029-02-01", end: "2029-02-05", status: "picked_up", key: "sw-pickedup" });
    const swapped = await swapVehicle(bk.id, { vehicleId: carB });
    expect(swapped.vehicleId).toBe(carB);
    expect(swapped.status).toBe("picked_up");
  });

  it("keeps the original price even when the replacement car has a different daily rate", async () => {
    // carA 5800/day, carB 6500/day. A real re-quote would change the total; a swap must not.
    const price = { total: 4242, currency: "USD", marker: "original-snapshot" };
    const bk = await seedBooking({ vehicleId: carA, start: "2029-03-01", end: "2029-03-05", source: "online", price, key: "sw-price" });
    const swapped = await swapVehicle(bk.id, { vehicleId: carB });
    expect(swapped.vehicleId).toBe(carB);
    expect(swapped.priceBreakdown).toEqual(price);
  });

  it("refuses to swap a completed booking", async () => {
    const bk = await seedBooking({ vehicleId: carA, start: "2029-04-01", end: "2029-04-05", status: "completed", key: "sw-completed" });
    await expectReject(swapVehicle(bk.id, { vehicleId: carB }), /no longer be swapped/i);
  });

  it("refuses to swap a cancelled booking", async () => {
    const bk = await seedBooking({ vehicleId: carA, start: "2029-04-10", end: "2029-04-14", status: "cancelled", key: "sw-cancelled" });
    await expectReject(swapVehicle(bk.id, { vehicleId: carB }), /no longer be swapped/i);
  });

  it("rejects a no-op swap onto the car it is already on", async () => {
    const bk = await createManualBooking({ vehicleId: carA, startAt: at("2029-05-01"), endAt: at("2029-05-05"), customerName: "SameCar" });
    await expectReject(swapVehicle(bk.id, { vehicleId: carA }), /different car|already on|same car/i);
  });

  it("rejects a swap onto a retired car", async () => {
    const bk = await createManualBooking({ vehicleId: carA, startAt: at("2029-06-01"), endAt: at("2029-06-05"), customerName: "ToRetired" });
    await expectReject(swapVehicle(bk.id, { vehicleId: retired }), /not available/i);
  });

  it("rejects a swap onto a car that is really booked in the same window (409)", async () => {
    await createManualBooking({ vehicleId: carB, startAt: at("2029-07-01"), endAt: at("2029-07-05"), customerName: "Occupant" });
    const bk = await createManualBooking({ vehicleId: carA, startAt: at("2029-07-01"), endAt: at("2029-07-05"), customerName: "Clash" });
    await expectReject(swapVehicle(bk.id, { vehicleId: carB }), /already|overlap|conflict|booked|not available/i);
    const [after] = await db.select().from(bookings).where(eq(bookings.id, bk.id));
    expect(after!.vehicleId).toBe(carA);
  });

  it("surfaces an advisory conflict for a soft block on the target, and honours override", async () => {
    await db.insert(availabilityBlocks).values({
      vehicleId: carC, startAt: at("2029-08-01"), endAt: at("2029-08-10"), type: "maintenance", reason: "service",
    });
    const bk = await createManualBooking({ vehicleId: carA, startAt: at("2029-08-01"), endAt: at("2029-08-05"), customerName: "Advisory" });
    try {
      await swapVehicle(bk.id, { vehicleId: carC });
      throw new Error("expected an advisory conflict");
    } catch (e) {
      const err = e as Error & { details?: { code?: string } };
      expect(err.details?.code).toBe("advisory_conflict");
    }
    const forced = await swapVehicle(bk.id, { vehicleId: carC, override: true });
    expect(forced.vehicleId).toBe(carC);
  });
});
