import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { vehicles, settings, bookings } from "@/lib/db/schema";
import { publicQuote, publicBookingConfig } from "@/lib/booking/public";
import { createBooking, type BookingCreateInput } from "@/lib/booking/create";
import { extendBooking } from "@/lib/admin/extend-booking";
import type { QuoteBreakdown } from "@/lib/booking/quote";

let db: Awaited<ReturnType<typeof getDb>>;

const TODAY = "2026-06-15";
const START = "2027-02-01T09:00:00-04:00";
const END = "2027-02-08T09:00:00-04:00"; // 7 rental days

beforeAll(async () => {
  db = await getDb();
  await runMigrations();
  await db.insert(settings).values({ id: 1 }).onConflictDoNothing();
  // Pin the values this suite depends on; earlier test files share the database
  // and may have patched settings.
  await db.update(settings)
    .set({ minDriverAge: 18, youngDriverAge: 21, youngDriverFeeCentsPerDay: 1000 })
    .where(eq(settings.id, 1));
  await db.insert(vehicles).values({
    slug: "yd-car", plate: "PL-yd-car", class: "SUV", name: "YD Car", seats: 5, transmission: "Automatic",
    doors: 5, priceDayCents: 5800, priceWeekCents: 34800, priceMonthCents: 118000, depositCents: 25000,
  });
});

describe("publicBookingConfig", () => {
  it("exposes the non-sensitive age-band settings for the wizard", async () => {
    const cfg = await publicBookingConfig();
    expect(cfg.minDriverAge).toBe(18);
    expect(cfg.youngDriverAge).toBe(21);
    expect(cfg.youngDriverFeeCentsPerDay).toBe(1000);
    expect(typeof cfg.currency).toBe("string");
    // the wizard's business hours (fix: previously hardcoded client-side)
    expect(cfg.openingTime).toBe("08:00");
    expect(cfg.closingTime).toBe("18:00");
    // nothing else leaks (no admin recipients, no retention settings)
    expect(Object.keys(cfg).sort()).toEqual(["closingTime", "currency", "minDriverAge", "openingTime", "youngDriverAge", "youngDriverFeeCentsPerDay"]);
  });
});

describe("publicQuote young driver", () => {
  it("prices the fee when the claimed band is young", async () => {
    const b = await publicQuote({ vehicleSlug: "yd-car", startAt: START, endAt: END, youngDriver: true }, TODAY);
    expect(b.youngDriver).toBe(true);
    expect(b.youngDriverCents).toBe(7 * 1000);
    expect(b.subtotalCents).toBe(b.vehicleCents + b.insuranceCents + b.addOnsCents + 7000);
  });

  it("prices no fee when the flag is omitted", async () => {
    const b = await publicQuote({ vehicleSlug: "yd-car", startAt: START, endAt: END }, TODAY);
    expect(b.youngDriver).toBe(false);
    expect(b.youngDriverCents).toBe(0);
  });
});

const baseLicense = {
  nameOnLicense: "Yara Young", licenseNumber: "AUA-9990001", issuingCountry: "Aruba",
  issueDate: "2026-01-01", expiryDate: "2036-01-01", dob: "2008-01-15", // 19 at the 2027-02-01 pick-up
};

function ydInput(over: Partial<BookingCreateInput> = {}): BookingCreateInput {
  return {
    vehicleSlug: "yd-car", startAt: START, endAt: END,
    customer: { email: "yara@example.com", name: "Yara Young", phone: "+297 000 1111" },
    insuranceTierId: null, addOns: [], license: { ...baseLicense },
    acceptTerms: true, paymentOption: "deposit",
    youngDriver: false,
    idempotencyKey: "yd-" + Math.random().toString(36).slice(2),
    ...over,
  } as BookingCreateInput;
}

describe("createBooking young-driver truth check", () => {
  it("honest young claim: fee applied, no adjustment flag", async () => {
    const { booking, breakdown, priceAdjusted } = await createBooking(
      ydInput({ youngDriver: true, idempotencyKey: "yd-honest-1" }), TODAY);
    expect(priceAdjusted).toBe(false);
    expect(breakdown.youngDriver).toBe(true);
    expect(breakdown.youngDriverCents).toBe(7000);
    const snap = booking.priceBreakdown as QuoteBreakdown;
    expect(snap.youngDriver).toBe(true);
    expect(snap.youngDriverCents).toBe(7000);
    expect(snap.subtotalCents).toBe(snap.vehicleCents + snap.insuranceCents + snap.addOnsCents + 7000);
  });

  it("claimed standard but DOB says young: booking created, repriced up, priceAdjusted true", async () => {
    const { breakdown, priceAdjusted } = await createBooking(
      ydInput({ youngDriver: false, startAt: "2027-03-01T09:00:00-04:00", endAt: "2027-03-08T09:00:00-04:00", idempotencyKey: "yd-up-1" }), TODAY);
    expect(priceAdjusted).toBe(true);
    expect(breakdown.youngDriver).toBe(true);
    expect(breakdown.youngDriverCents).toBe(7000);
  });

  it("claimed young but DOB says standard: fee dropped, priceAdjusted true", async () => {
    const { breakdown, priceAdjusted } = await createBooking(
      ydInput({
        youngDriver: true,
        license: { ...baseLicense, licenseNumber: "AUA-9990002", dob: "2000-05-17" }, // 26 at pick-up
        customer: { email: "olga@example.com", name: "Olga Older", phone: "+297 000 2222" },
        startAt: "2027-04-01T09:00:00-04:00", endAt: "2027-04-08T09:00:00-04:00",
        idempotencyKey: "yd-down-1",
      }), TODAY);
    expect(priceAdjusted).toBe(true);
    expect(breakdown.youngDriver).toBe(false);
    expect(breakdown.youngDriverCents).toBe(0);
  });

  it("under minDriverAge still hard-rejects", async () => {
    await expect(createBooking(
      ydInput({ license: { ...baseLicense, dob: "2010-06-01" }, idempotencyKey: "yd-under-1" }), TODAY),
    ).rejects.toThrow(/at least 18/i);
  });

  it("idempotent replay reports the same adjustment against the same claim", async () => {
    const first = await createBooking(
      ydInput({ youngDriver: false, startAt: "2027-05-01T09:00:00-04:00", endAt: "2027-05-08T09:00:00-04:00", idempotencyKey: "yd-replay-1" }), TODAY);
    expect(first.priceAdjusted).toBe(true);
    const again = await createBooking(
      ydInput({ youngDriver: false, startAt: "2027-05-01T09:00:00-04:00", endAt: "2027-05-08T09:00:00-04:00", idempotencyKey: "yd-replay-1" }), TODAY);
    expect(again.replayed).toBe(true);
    expect(again.booking.id).toBe(first.booking.id);
    expect(again.priceAdjusted).toBe(true); // still true for the same wrong claim
  });
});

describe("extendBooking keeps the young-driver fee", () => {
  it("re-quotes the full new duration with the snapshotted flag", async () => {
    const { booking } = await createBooking(ydInput({
      youngDriver: true,
      startAt: "2027-06-01T09:00:00-04:00", endAt: "2027-06-04T09:00:00-04:00", // 3 days
      idempotencyKey: "yd-extend-1",
    }), TODAY);
    await db.update(bookings).set({ status: "confirmed" }).where(eq(bookings.id, booking.id));

    await extendBooking(booking.id, {
      endAt: "2027-06-06T09:00:00-04:00", // now 5 days
      payment: "desk",
      role: "owner",
    });

    const [updated] = await db.select().from(bookings).where(eq(bookings.id, booking.id));
    const snap = updated!.priceBreakdown as QuoteBreakdown;
    expect(snap.youngDriver).toBe(true);
    expect(snap.youngDriverCents).toBe(5 * 1000);
    expect(snap.subtotalCents).toBe(snap.vehicleCents + snap.insuranceCents + snap.addOnsCents + 5000);
  });
});
