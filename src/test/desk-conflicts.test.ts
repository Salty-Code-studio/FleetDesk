import { describe, it, expect, beforeAll } from "vitest";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { vehicles, settings, availabilityBlocks } from "@/lib/db/schema";
import { createManualBooking } from "@/lib/admin/manual-booking";
import { moveBooking } from "@/lib/admin/move-booking";
import { atAruba } from "@/lib/time/format";
import { expectReject } from "./util";

let db: Awaited<ReturnType<typeof getDb>>;
let carA = ""; // carries an availability block 2026-08-10..12
let carB = ""; // free, used to create movable bookings

const at = (d: string) => atAruba(d, "09:00");

beforeAll(async () => {
  db = await getDb();
  await runMigrations();
  await db.insert(settings).values({ id: 1 }).onConflictDoNothing();
  const [a] = await db.insert(vehicles).values({
    slug: "desk-conflict-a", plate: "DC-A", class: "SUV", name: "Desk Conflict A", seats: 5, transmission: "Automatic",
    doors: 5, priceDayCents: 5800, priceWeekCents: 34800, priceMonthCents: 118000,
  }).returning();
  const [b] = await db.insert(vehicles).values({
    slug: "desk-conflict-b", plate: "DC-B", class: "SUV", name: "Desk Conflict B", seats: 5, transmission: "Automatic",
    doors: 5, priceDayCents: 6500, priceWeekCents: 39000, priceMonthCents: 132000,
  }).returning();
  carA = a!.id; carB = b!.id;
  await db.insert(availabilityBlocks).values({
    vehicleId: carA, startAt: atAruba("2026-08-10", "00:00"), endAt: atAruba("2026-08-12", "00:00"), reason: "Service",
  });
  // A second, separate block window on the same car — dedicated to the move
  // tests below, so they never collide with the manual-booking tests' use of
  // the first block window (which they occupy with a real booking via override).
  await db.insert(availabilityBlocks).values({
    vehicleId: carA, startAt: atAruba("2026-11-10", "00:00"), endAt: atAruba("2026-11-12", "00:00"), reason: "Service",
  });
});

describe("desk advisory conflicts — manual bookings", () => {
  it("rejects a manual booking over a block without override", async () => {
    await expectReject(
      createManualBooking({
        vehicleId: carA, startAt: at("2026-08-10"), endAt: atAruba("2026-08-11", "09:00"),
        customerName: "Desk Test",
      }),
      /unavailable/i,
    );
  });

  it("allows the same booking with override: true", async () => {
    const b = await createManualBooking({
      vehicleId: carA, startAt: at("2026-08-10"), endAt: atAruba("2026-08-11", "09:00"),
      customerName: "Desk Test", override: true,
    });
    expect(b.status).toBe("confirmed");
  });
});

describe("desk advisory conflicts — moves", () => {
  it("rejects a move onto a blocked window without override", async () => {
    const bk = await createManualBooking({ vehicleId: carB, startAt: at("2026-09-01"), endAt: at("2026-09-03"), customerName: "Movable" });
    await expectReject(
      moveBooking(bk.id, { vehicleId: carA, startAt: at("2026-11-10"), endAt: atAruba("2026-11-11", "09:00") }),
      /unavailable/i,
    );
  });

  it("allows the same move with override: true", async () => {
    const bk = await createManualBooking({ vehicleId: carB, startAt: at("2026-09-05"), endAt: at("2026-09-07"), customerName: "Movable2" });
    const moved = await moveBooking(bk.id, {
      vehicleId: carA, startAt: at("2026-11-10"), endAt: atAruba("2026-11-11", "09:00"), override: true,
    });
    expect(moved.vehicleId).toBe(carA);
  });

  it("a same-car date tweak does not clash against its own prior row (excludeBookingId)", async () => {
    const bk = await createManualBooking({ vehicleId: carB, startAt: at("2026-10-01"), endAt: at("2026-10-05"), customerName: "SelfTweak" });
    // Shift by a day on the same car — the booking's OWN pre-move row must not
    // be counted as a clash against the recomputed range.
    const moved = await moveBooking(bk.id, { startAt: at("2026-10-02"), endAt: at("2026-10-06") });
    expect(moved.id).toBe(bk.id);
  });
});
