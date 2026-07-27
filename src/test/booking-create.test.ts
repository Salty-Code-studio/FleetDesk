import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { vehicles, settings, addOns, insuranceTiers, driverLicenses, bookings, bookingAddOns } from "@/lib/db/schema";
import { createBooking, type BookingCreateInput } from "@/lib/booking/create";
import { decryptField } from "@/lib/crypto/fields";
import { atAruba } from "@/lib/time/format";

let db: Awaited<ReturnType<typeof getDb>>;
let limitedAddOnId = "";
let tierId = "";

const at = (d: string) => atAruba(d, "09:00");
const TODAY = at("2026-06-15");
const baseLicense = {
  nameOnLicense: "Jane Driver", licenseNumber: "AUA-7654321", issuingCountry: "Aruba",
  issueDate: "2020-01-01", expiryDate: "2030-01-01", dob: "2000-05-17",
};

function input(over: Partial<BookingCreateInput> = {}): BookingCreateInput {
  return {
    vehicleSlug: "book-car", startAt: at("2026-07-01"), endAt: at("2026-07-08"),
    customer: { email: "jane@example.com", name: "Jane Driver", phone: "+297 000 0000" },
    insuranceTierId: null, addOns: [], license: { ...baseLicense },
    acceptTerms: true, paymentOption: "reservation_fee",
    idempotencyKey: "idem-" + Math.random().toString(36).slice(2),
    ...over,
  } as BookingCreateInput;
}

beforeAll(async () => {
  db = await getDb();
  await runMigrations();
  await db.insert(settings).values({ id: 1 }).onConflictDoNothing();
  await db.insert(vehicles).values({
    slug: "book-car", plate: "PL-book-car", class: "SUV", name: "Book Car", seats: 5, transmission: "Automatic",
    doors: 5, priceDayCents: 5800, priceWeekCents: 34800, priceMonthCents: 118000, depositCents: 25000,
  });
  const [tier] = await db.insert(insuranceTiers).values({ name: "Premium", dailyPriceCents: 1500, isDefault: false }).returning();
  tierId = tier!.id;
  const [a] = await db.insert(addOns).values({ name: "Baby chair", priceCents: 500, pricing: "per_day", stock: 2 }).returning();
  limitedAddOnId = a!.id;
  // a second vehicle so add-on stock (shared equipment) can be tested without
  // tripping the per-vehicle overlap guard first
  await db.insert(vehicles).values({
    slug: "book-car-2", plate: "PL-book-car-2", class: "SUV", name: "Book Car 2", seats: 5, transmission: "Automatic",
    doors: 5, priceDayCents: 6500, priceWeekCents: 39000, priceMonthCents: 132000, depositCents: 25000,
  });
});

describe("createBooking", () => {
  it("creates a pending booking with a server-computed price snapshot, add-ons, and an encrypted licence", async () => {
    const { booking, breakdown, replayed } = await createBooking(input({
      insuranceTierId: tierId,
      addOns: [{ addOnId: limitedAddOnId, qty: 1 }],
      idempotencyKey: "happy-1",
    }), TODAY);
    expect(replayed).toBe(false);
    expect(booking.status).toBe("pending");
    expect(breakdown.vehicleCents).toBe(34800);            // weekly
    expect(breakdown.insuranceCents).toBe(1500 * 7);
    expect(breakdown.addOnsCents).toBe(500 * 7);
    expect(booking.priceBreakdown).toMatchObject({ subtotalCents: breakdown.subtotalCents });

    const [lic] = await db.select().from(driverLicenses).where(eq(driverLicenses.bookingId, booking.id));
    expect(lic).toBeDefined();
    // stored as raw bytes, decryptable only with the bound context
    expect(decryptField(lic!.licenseNumberEnc, `driver_licenses:${booking.id}:license_number`)).toBe("AUA-7654321");
    expect(lic!.retainUntil).toBeInstanceOf(Date);

    const lines = await db.select().from(bookingAddOns).where(eq(bookingAddOns.bookingId, booking.id));
    expect(lines.length).toBe(1);
    expect(lines[0]!.priceSnapshotCents).toBe(3500);
  });

  it("is idempotent: the same key returns the same booking, no duplicate", async () => {
    const a = await createBooking(input({ startAt: at("2026-10-01"), endAt: at("2026-10-05"), idempotencyKey: "dupe-key" }), TODAY);
    const b = await createBooking(input({ startAt: at("2026-10-01"), endAt: at("2026-10-05"), idempotencyKey: "dupe-key" }), TODAY);
    expect(b.replayed).toBe(true);
    expect(b.booking.id).toBe(a.booking.id);
    const all = await db.select().from(bookings).where(eq(bookings.idempotencyKey, "dupe-key"));
    expect(all.length).toBe(1);
  });

  it("rejects an overlapping booking for the same vehicle (the exclusion constraint)", async () => {
    await createBooking(input({ startAt: at("2026-11-01"), endAt: at("2026-11-08"), idempotencyKey: "ov-1" }), TODAY);
    await expect(
      createBooking(input({ startAt: at("2026-11-05"), endAt: at("2026-11-12"), idempotencyKey: "ov-2" }), TODAY),
    ).rejects.toThrow(/not available|already booked|overlap/i);
  });

  it("rejects an add-on oversell across overlapping dates (shared equipment, different cars)", async () => {
    // stock is 2; book qty 2 on car 1, then an OVERLAPPING booking on car 2 for
    // qty 1 must fail the stock check (not the per-vehicle overlap guard)
    await createBooking(input({ vehicleSlug: "book-car", startAt: at("2027-01-01"), endAt: at("2027-01-05"), addOns: [{ addOnId: limitedAddOnId, qty: 2 }], idempotencyKey: "stock-1" }), TODAY);
    await expect(
      createBooking(input({ vehicleSlug: "book-car-2", startAt: at("2027-01-02"), endAt: at("2027-01-06"), addOns: [{ addOnId: limitedAddOnId, qty: 1 }], idempotencyKey: "stock-2" }), TODAY),
    ).rejects.toThrow(/left for those dates/i);
  });

  it("rejects full_deposit when the car has no deposit set", async () => {
    await db.insert(vehicles).values({
      slug: "no-deposit", plate: "PL-no-deposit", class: "Economy", name: "No Deposit", seats: 4, transmission: "Automatic",
      doors: 4, priceDayCents: 3500, priceWeekCents: 21000, priceMonthCents: 72000, depositCents: null,
    });
    await expect(
      createBooking(input({ vehicleSlug: "no-deposit", paymentOption: "full_deposit", idempotencyKey: "dep-1" }), TODAY),
    ).rejects.toThrow(/full deposit/i);
  });

  it("rejects an under-age driver end to end", async () => {
    await expect(
      createBooking(input({ license: { ...baseLicense, dob: "2012-01-01" }, idempotencyKey: "age-1" }), TODAY),
    ).rejects.toThrow(/at least/i);
  });

  it("treats a duplicated add-on in one request as summed quantity (no single-request oversell)", async () => {
    // stock is 2; sending the same add-on twice at qty 2 each must be rejected
    await expect(
      createBooking(input({
        vehicleSlug: "book-car", startAt: at("2027-05-01"), endAt: at("2027-05-05"),
        addOns: [{ addOnId: limitedAddOnId, qty: 2 }, { addOnId: limitedAddOnId, qty: 2 }],
        idempotencyKey: "dup-stock-1",
      }), TODAY),
    ).rejects.toThrow(/left for those dates/i);
  });

  it("never returns licence plaintext on the booking", async () => {
    const { booking } = await createBooking(input({ startAt: at("2027-03-01"), endAt: at("2027-03-05"), idempotencyKey: "leak-1" }), TODAY);
    expect(JSON.stringify(booking)).not.toContain("AUA-7654321");
    expect(JSON.stringify(booking)).not.toContain("2000-05-17");
  });
});
