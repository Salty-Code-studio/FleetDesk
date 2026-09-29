import { describe, it, expect, beforeAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
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

  it("auto-sorts: the rental already on the target moves to a free car instead of refusing", async () => {
    const occ = await createManualBooking({ vehicleId: carB, startAt: at("2029-07-01"), endAt: at("2029-07-05"), customerName: "Occupant" });
    const bk = await createManualBooking({ vehicleId: carA, startAt: at("2029-07-01"), endAt: at("2029-07-05"), customerName: "Clash" });
    const swapped = await swapVehicle(bk.id, { vehicleId: carB });
    expect(swapped.vehicleId).toBe(carB);
    expect(swapped.moved).toHaveLength(1);
    expect(swapped.moved[0]!.id).toBe(occ.id);
    expect(swapped.moved[0]!.customerName).toBe("Occupant");
    const [after] = await db.select().from(bookings).where(eq(bookings.id, occ.id));
    expect(after!.vehicleId).not.toBe(carB);
    expect(after!.status).toBe(occ.status);
    expect(sameInstant(after!.startAt, "2029-07-01")).toBe(true);
    expect(after!.priceBreakdown).toEqual(occ.priceBreakdown);
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

  describe("auto-sort across an identical fleet", () => {
    /** A private class per scenario so other tests' cars never join the pool. */
    async function fleet(cls: string, n: number) {
      const ids: string[] = [];
      for (let i = 1; i <= n; i++) {
        const [v] = await db.insert(vehicles).values({
          slug: `${cls}-${i}`, plate: `${cls.toUpperCase()}-${i}`, class: cls, name: `${cls} ${i}`, seats: 2,
          transmission: "Automatic", doors: 0, priceDayCents: 2250, priceWeekCents: 15000, priceMonthCents: 30000,
        }).returning();
        ids.push(v!.id);
      }
      return ids;
    }
    const vehicleOf = async (id: string) => (await db.select().from(bookings).where(eq(bookings.id, id)))[0]!.vehicleId;

    it("re-sorts a chain when moving only the clashing rental does not fit", async () => {
      const [s1, s2, s3] = await fleet("chain", 3);
      await db.insert(availabilityBlocks).values({ vehicleId: s3!, startAt: at("2030-01-01"), endAt: at("2030-01-20"), type: "maintenance", reason: "" });
      const b = await seedBooking({ vehicleId: s1!, start: "2030-01-01", end: "2030-01-03", key: "ch-b" });
      const e = await seedBooking({ vehicleId: s1!, start: "2030-01-05", end: "2030-01-10", key: "ch-e" });
      const d = await seedBooking({ vehicleId: s2!, start: "2030-01-02", end: "2030-01-08", key: "ch-d" });
      const swapped = await swapVehicle(b.id, { vehicleId: s2! });
      expect(swapped.vehicleId).toBe(s2);
      expect(await vehicleOf(d.id)).toBe(s1);
      expect(await vehicleOf(e.id)).toBe(s2);
      expect(swapped.moved.map((m) => m.id).sort()).toEqual([d.id, e.id].sort());
    });

    it("refuses when the target scooter is still out with another renter", async () => {
      const [s1, s2] = await fleet("outx", 2);
      const b = await seedBooking({ vehicleId: s1!, start: "2030-02-01", end: "2030-02-05", key: "out-b" });
      await seedBooking({ vehicleId: s2!, start: "2030-01-28", end: "2030-02-03", status: "picked_up", key: "out-p" });
      await expectReject(swapVehicle(b.id, { vehicleId: s2! }), /still marked as out/i);
      expect(await vehicleOf(b.id)).toBe(s1);
    });

    it("refuses and changes nothing when the fleet is genuinely full", async () => {
      const [s1, s2, s3] = await fleet("full", 3);
      await db.insert(availabilityBlocks).values({ vehicleId: s3!, startAt: at("2030-03-01"), endAt: at("2030-03-20"), type: "maintenance", reason: "" });
      const b = await seedBooking({ vehicleId: s1!, start: "2030-03-01", end: "2030-03-03", key: "full-b" });
      await seedBooking({ vehicleId: s1!, start: "2030-03-04", end: "2030-03-10", status: "picked_up", key: "full-e" });
      const d = await seedBooking({ vehicleId: s2!, start: "2030-03-02", end: "2030-03-08", key: "full-d" });
      await expectReject(swapVehicle(b.id, { vehicleId: s2! }), /no free vehicle/i);
      expect(await vehicleOf(b.id)).toBe(s1);
      expect(await vehicleOf(d.id)).toBe(s2);
      const [dAfter] = await db.select().from(bookings).where(eq(bookings.id, d.id));
      expect(dAfter!.status).toBe("confirmed");
    });

    it("moves several clashing rentals at once and keeps their statuses", async () => {
      const [s1, s2, s3, s4] = await fleet("multi", 4);
      const b = await seedBooking({ vehicleId: s1!, start: "2030-04-01", end: "2030-04-10", key: "mu-b" });
      const x = await seedBooking({ vehicleId: s2!, start: "2030-04-01", end: "2030-04-03", status: "pending", key: "mu-x" });
      const y = await seedBooking({ vehicleId: s2!, start: "2030-04-05", end: "2030-04-07", key: "mu-y" });
      await seedBooking({ vehicleId: s3!, start: "2030-04-01", end: "2030-04-12", key: "mu-z" });
      const swapped = await swapVehicle(b.id, { vehicleId: s2! });
      expect(swapped.moved).toHaveLength(2);
      for (const id of [x.id, y.id]) expect([s1, s4]).toContain(await vehicleOf(id));
      expect((await db.select().from(bookings).where(eq(bookings.id, x.id)))[0]!.status).toBe("pending");
    });

    it("Sjonnie's case: walk-in gets scooter 5, its Nov-Jan rental finds a home even when that means shuffling others", async () => {
      const [s1, s2, s3] = await fleet("winter", 3); // s1 plays "scooter 5"
      const long = await seedBooking({ vehicleId: s1!, start: "2030-11-01", end: "2031-01-31", key: "w-long" });
      const a = await seedBooking({ vehicleId: s2!, start: "2030-10-20", end: "2030-11-10", key: "w-a" });
      const b = await seedBooking({ vehicleId: s2!, start: "2030-12-01", end: "2030-12-20", key: "w-b" });
      const c = await seedBooking({ vehicleId: s3!, start: "2030-11-15", end: "2030-11-30", key: "w-c" });
      const d = await seedBooking({ vehicleId: s3!, start: "2031-01-05", end: "2031-01-20", key: "w-d" });
      // The walk-in was put on s3 (free that week) and then handed scooter 5.
      const walk = await seedBooking({ vehicleId: s3!, start: "2030-10-29", end: "2030-11-03", key: "w-walk" });

      const swapped = await swapVehicle(walk.id, { vehicleId: s1!, reason: "walk_in" });
      expect(swapped.vehicleId).toBe(s1);
      expect(await vehicleOf(long.id)).not.toBe(s1);

      // Every rental keeps its dates, sits on one scooter, and no scooter is double-booked.
      const all = await db.select().from(bookings).where(inArray(bookings.id, [long.id, a.id, b.id, c.id, d.id, walk.id]));
      for (const x of all) {
        for (const y of all) {
          if (x.id < y.id && x.vehicleId === y.vehicleId) {
            expect(parseTs(x.startAt) < parseTs(y.bufferEndAt) && parseTs(y.startAt) < parseTs(x.bufferEndAt)).toBe(false);
          }
        }
      }
      const longAfter = all.find((x) => x.id === long.id)!;
      expect(sameInstant(longAfter.startAt, "2030-11-01")).toBe(true);
      expect(sameInstant(longAfter.endAt, "2031-01-31")).toBe(true);
      expect(swapped.moved.some((m) => m.id === long.id)).toBe(true);
    });

    it("a repair swap never hands re-sorted rentals to the broken scooter", async () => {
      const [s1, s2, s3] = await fleet("brk", 3);
      const bk = await seedBooking({ vehicleId: s1!, start: "2030-05-01", end: "2030-05-05", status: "picked_up", key: "brk-b" });
      const occ = await seedBooking({ vehicleId: s2!, start: "2030-05-02", end: "2030-05-04", key: "brk-o" });
      await swapVehicle(bk.id, { vehicleId: s2!, reason: "repair" });
      expect(await vehicleOf(occ.id)).toBe(s3);
    });

    it("sees older rentals too: a swap of a rental picked up in the past never lands the moved one on a hidden clash", async () => {
      // Dates in the PAST: the swapped rental was picked up days ago, and the one
      // on the target began even earlier. A rental that ended before the swapped
      // one started can still clash with the one being moved.
      const [s1, s2, s3] = await fleet("past", 3);
      await seedBooking({ vehicleId: s1!, start: "2026-09-03", end: "2026-09-08", key: "past-z" }); // hidden clash for D on s1
      const b = await seedBooking({ vehicleId: s1!, start: "2026-09-10", end: "2099-01-01", status: "picked_up", key: "past-b" });
      const d = await seedBooking({ vehicleId: s2!, start: "2026-09-05", end: "2099-01-05", key: "past-d" });
      const swapped = await swapVehicle(b.id, { vehicleId: s2!, reason: "walk_in" });
      expect(swapped.vehicleId).toBe(s2);
      expect(await vehicleOf(d.id)).toBe(s3);
    });
  });
});
