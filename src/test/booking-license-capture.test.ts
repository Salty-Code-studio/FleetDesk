import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { vehicles, customers, bookings, driverLicenses, settings } from "@/lib/db/schema";
import { saveBookingLicense } from "@/lib/admin/booking-license";
import { getHandover } from "@/lib/admin/inspections";
import { decryptField } from "@/lib/crypto/fields";

let db: Awaited<ReturnType<typeof getDb>>;
let vehicleId = "", customerId = "";
let seq = 1;
const NOW = "2027-01-10T13:00:00Z";

const lic = (over: Record<string, string> = {}) => ({
  nameOnLicense: "Sam Driver", licenseNumber: "NL-123456", issuingCountry: "Netherlands",
  issueDate: "2020-01-01", expiryDate: "2035-01-01", dob: "1990-03-03", ...over,
});

async function mkBooking(status: "confirmed" | "cancelled" | "completed", youngDriver: boolean) {
  const m = String(seq++).padStart(2, "0");
  const [b] = await db.insert(bookings).values({
    vehicleId, customerId,
    startAt: `2028-${m}-01T13:00:00Z`,
    endAt: `2028-${m}-05T13:00:00Z`,
    bufferEndAt: `2028-${m}-06T13:00:00Z`,
    status,
    priceBreakdown: { subtotalCents: 40000, currency: "USD", days: 4, youngDriver, youngDriverCents: youngDriver ? 4000 : 0 },
    paymentOption: "full", acceptedPolicyVersion: 1, acceptedAt: new Date(),
    idempotencyKey: `liccap-${m}`,
  }).returning();
  return b!;
}

beforeAll(async () => {
  db = await getDb();
  await runMigrations();
  await db.insert(settings).values({ id: 1 }).onConflictDoNothing();
  const [v] = await db.insert(vehicles).values({
    slug: "lic-car", plate: "PL-lic", class: "SUV", name: "Licence Car", seats: 5,
    transmission: "Automatic", doors: 5, priceDayCents: 10000, priceWeekCents: 60000,
    priceMonthCents: 200000,
  }).returning();
  vehicleId = v!.id;
  const [c] = await db.insert(customers).values({ email: "lic@example.com", name: "Sam" }).returning();
  customerId = c!.id;
});

describe("saveBookingLicense", () => {
  it("stores the licence encrypted and reports no mismatch for a matching band", async () => {
    const b = await mkBooking("confirmed", false);
    const res = await saveBookingLicense(b.id, lic(), NOW);
    expect(res).toEqual({ band: "standard", bookedYoung: false, mismatch: false });
    const [row] = await db.select().from(driverLicenses).where(eq(driverLicenses.bookingId, b.id));
    expect(decryptField(row!.licenseNumberEnc, `driver_licenses:${b.id}:license_number`)).toBe("NL-123456");
    expect(decryptField(row!.dobEnc, `driver_licenses:${b.id}:dob`)).toBe("1990-03-03");
  });

  it("replaces an earlier licence instead of adding a second row", async () => {
    const b = await mkBooking("confirmed", false);
    await saveBookingLicense(b.id, lic(), NOW);
    await saveBookingLicense(b.id, lic({ licenseNumber: "NL-999" }), NOW);
    const rows = await db.select().from(driverLicenses).where(eq(driverLicenses.bookingId, b.id));
    expect(rows).toHaveLength(1);
    expect(decryptField(rows[0]!.licenseNumberEnc, `driver_licenses:${b.id}:license_number`)).toBe("NL-999");
  });

  it("refuses an under-age driver and tells the desk not to hand over", async () => {
    const b = await mkBooking("confirmed", false);
    await expect(saveBookingLicense(b.id, lic({ dob: "2012-01-01" }), NOW)).rejects.toThrow(/at least 18.*Do not hand over the car/);
  });

  it("refuses a completed rental", async () => {
    const b = await mkBooking("completed", false);
    await expect(saveBookingLicense(b.id, lic(), NOW)).rejects.toThrow(/already closed/i);
  });

  it("refuses a licence that expires before the return", async () => {
    const b = await mkBooking("confirmed", false);
    await expect(saveBookingLicense(b.id, lic({ expiryDate: "2028-01-01" }), NOW)).rejects.toThrow(/valid through/i);
  });

  it("refuses a cancelled booking", async () => {
    const b = await mkBooking("cancelled", false);
    await expect(saveBookingLicense(b.id, lic(), NOW)).rejects.toThrow(/cancelled/i);
  });

  it("flags a young driver booked without the fee, and the reverse", async () => {
    const young = { dob: "2009-01-01" };
    const b1 = await mkBooking("confirmed", false);
    expect(await saveBookingLicense(b1.id, lic(young), NOW)).toEqual({ band: "young", bookedYoung: false, mismatch: true });
    const b2 = await mkBooking("confirmed", true);
    expect(await saveBookingLicense(b2.id, lic(), NOW)).toEqual({ band: "standard", bookedYoung: true, mismatch: true });
  });
});

describe("getHandover young driver fields", () => {
  it("exposes the claimed band and the fee the stay would cost", async () => {
    const b = await mkBooking("confirmed", false);
    const [s] = await db.select().from(settings).where(eq(settings.id, 1));
    const h = await getHandover(b.id);
    expect(h.booking.youngDriver).toBe(false);
    expect(h.booking.youngDriverFeeCents).toBe(s!.youngDriverFeeCentsPerDay * 4);
    expect(h.licenceCheck).toBeNull();
  });

  it("recomputes the licence check on every read, without the date of birth", async () => {
    const b = await mkBooking("confirmed", false);
    await saveBookingLicense(b.id, lic({ dob: "2009-01-01" }), NOW);
    const h = await getHandover(b.id);
    expect(h.licenceCheck).toEqual({ band: "young", bookedYoung: false, mismatch: true });
    expect(JSON.stringify(h)).not.toContain("2009-01-01");
    expect(JSON.stringify(h)).not.toContain("dobEnc");
  });
});
