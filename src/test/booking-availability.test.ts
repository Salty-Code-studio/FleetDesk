import { describe, it, expect, beforeAll } from "vitest";
import { runMigrations } from "@/lib/db/migrate";
import { getDb } from "@/lib/db/client";
import { vehicles, customers, bookings, availabilityBlocks, blackoutDates } from "@/lib/db/schema";
import { validateDates, checkAvailability } from "@/lib/booking/availability";
import { atAruba } from "@/lib/time/format";

let db: Awaited<ReturnType<typeof getDb>>;
let vehicleId = "";
let customerId = "";

const settings = { minRentalDays: 1, maxRentalDays: 90, maxAdvanceDays: 365, turnaroundBufferHours: 24 };
const at = (d: string) => atAruba(d, "09:00");
const TODAY = at("2026-06-15");

beforeAll(async () => {
  db = await getDb();
  await runMigrations();
  const [v] = await db.insert(vehicles).values({
    slug: "avail-car", plate: "PL-avail-car", class: "SUV", name: "Avail Car", seats: 5, transmission: "Automatic",
    doors: 5, priceDayCents: 5800, priceWeekCents: 34800, priceMonthCents: 118000,
  }).returning();
  const [c] = await db.insert(customers).values({ email: "a@a.com" }).returning();
  vehicleId = v!.id; customerId = c!.id;
});

describe("validateDates", () => {
  it("accepts a valid range", () => {
    expect(() => validateDates(at("2026-07-01"), at("2026-07-08"), settings, TODAY)).not.toThrow();
  });
  it("rejects past, zero-length, too-short, too-long, too-far", () => {
    expect(() => validateDates(at("2026-06-01"), at("2026-06-05"), settings, TODAY)).toThrow(/past/i);
    expect(() => validateDates(at("2026-07-01"), at("2026-07-01"), settings, TODAY)).toThrow(/after/i);
    expect(() => validateDates(at("2026-07-01"), at("2026-07-02"), { ...settings, minRentalDays: 3 }, TODAY)).toThrow(/Minimum/i);
    expect(() => validateDates(at("2026-07-01"), at("2026-09-01"), { ...settings, maxRentalDays: 30 }, TODAY)).toThrow(/Maximum/i);
    expect(() => validateDates(at("2028-01-01"), at("2028-01-05"), settings, TODAY)).toThrow(/ahead/i);
  });
});

describe("checkAvailability", () => {
  it("is available with nothing booked", async () => {
    expect((await checkAvailability(vehicleId, at("2026-07-01"), at("2026-07-08"), settings)).available).toBe(true);
  });

  it("is unavailable when a booking overlaps", async () => {
    // bufferEndAt = endAt + 24-hour turnaround, exactly as createBooking stores
    // it. checkAvailability mirrors the DB exclusion constraint by overlapping
    // each row on its OWN stored bufferEndAt (so raising the global buffer later
    // never retro-blocks a slot the constraint would still accept).
    await db.insert(bookings).values({
      vehicleId, customerId, startAt: at("2026-08-01"), endAt: at("2026-08-10"), bufferEndAt: at("2026-08-11"), status: "confirmed",
      priceBreakdown: {}, paymentOption: "reservation_fee", acceptedPolicyVersion: 1, acceptedAt: new Date(), idempotencyKey: "av-k1",
    });
    expect((await checkAvailability(vehicleId, at("2026-08-05"), at("2026-08-12"), settings)).available).toBe(false);
  });

  it("enforces the turnaround buffer (no back-to-back within the gap)", async () => {
    // existing booking ends 2026-08-10; with a 24-hour buffer, a new pickup on 08-10 clashes
    expect((await checkAvailability(vehicleId, at("2026-08-10"), at("2026-08-14"), settings)).available).toBe(false);
    // but 08-11 (one clear day after) is fine
    expect((await checkAvailability(vehicleId, at("2026-08-11"), at("2026-08-14"), settings)).available).toBe(true);
  });

  it("respects availability blocks", async () => {
    await db.insert(availabilityBlocks).values({ vehicleId, startAt: atAruba("2026-09-01", "00:00"), endAt: atAruba("2026-09-05", "00:00"), reason: "Service" });
    expect((await checkAvailability(vehicleId, at("2026-09-03"), at("2026-09-08"), settings)).available).toBe(false);
  });

  it("respects blackout dates across the whole fleet", async () => {
    await db.insert(blackoutDates).values({ startDate: "2026-12-24", endDate: "2026-12-27", reason: "Holiday" });
    expect((await checkAvailability(vehicleId, at("2026-12-23"), at("2026-12-26"), settings)).available).toBe(false);
  });

  it("reports a retired vehicle as unavailable", async () => {
    const [r] = await db.insert(vehicles).values({
      slug: "retired-avail", plate: "PL-retired-avail", class: "Van", name: "Retired", seats: 8, transmission: "Automatic",
      doors: 5, priceDayCents: 1, priceWeekCents: 1, priceMonthCents: 1, status: "retired",
    }).returning();
    expect((await checkAvailability(r!.id, at("2026-07-01"), at("2026-07-03"), settings)).available).toBe(false);
  });
});
