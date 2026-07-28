import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { vehicles, customers, bookings, driverLicenses } from "@/lib/db/schema";
import { sweepDriverLicenses } from "@/lib/admin/inspections";

/**
 * Regression coverage for the retention-timer bug: createBooking writes
 * driver_licenses.retainUntil as a documented auto-delete timer, but nothing
 * ever consumed it (the daily cron only swept inspection media; bookings are
 * never row-deleted so the ON DELETE CASCADE never fires). This exercises the
 * sweep directly, mirroring inspection-retention.test.ts.
 */
let db: Awaited<ReturnType<typeof getDb>>;
let vehicleId = "", customerId = "";
let seq = 1;

const DAY = 86_400_000;

async function mkBooking(status: "completed" | "confirmed", endInMs: number) {
  const n = seq++;
  const end = new Date(Date.now() + endInMs);
  const [b] = await db.insert(bookings).values({
    vehicleId, customerId,
    startAt: new Date(end.getTime() - 4 * DAY).toISOString(),
    endAt: end.toISOString(),
    bufferEndAt: new Date(end.getTime() + DAY).toISOString(),
    status,
    priceBreakdown: { subtotalCents: 40000, currency: "USD" },
    paymentOption: "deposit", acceptedPolicyVersion: 1, acceptedAt: new Date(),
    idempotencyKey: `license-sweep-${n}`,
  }).returning();
  return b!;
}

async function mkLicense(bookingId: string, retainUntil: Date) {
  await db.insert(driverLicenses).values({
    bookingId,
    nameOnLicense: "Jane Driver",
    licenseNumberEnc: Buffer.from("ciphertext-number"),
    issuingCountry: "Aruba",
    issueDate: "2020-01-01",
    expiryDate: "2030-01-01",
    dobEnc: Buffer.from("ciphertext-dob"),
    retainUntil,
  });
}

beforeAll(async () => {
  db = await getDb();
  await runMigrations();
  const [v] = await db.insert(vehicles).values({
    slug: "license-sweep-car", plate: "PL-lic-sweep", class: "SUV", name: "License Sweep Car", seats: 5,
    transmission: "Automatic", doors: 5, priceDayCents: 1, priceWeekCents: 1, priceMonthCents: 1,
  }).returning();
  const [c] = await db.insert(customers).values({ email: "license-sweep@test.com" }).returning();
  vehicleId = v!.id; customerId = c!.id;
});

describe("sweepDriverLicenses", () => {
  it("purges a driver_licenses row past its retainUntil on a completed booking", async () => {
    const b = await mkBooking("completed", -200 * DAY);
    await mkLicense(b.id, new Date(Date.now() - DAY)); // retainUntil was yesterday

    const purged = await sweepDriverLicenses();
    expect(purged).toBeGreaterThanOrEqual(1);

    const [row] = await db.select().from(driverLicenses).where(eq(driverLicenses.bookingId, b.id));
    expect(row).toBeUndefined(); // PII gone, not retained forever
  });

  it("leaves a row still within its retention window untouched", async () => {
    const b = await mkBooking("completed", -5 * DAY);
    await mkLicense(b.id, new Date(Date.now() + 30 * DAY)); // retainUntil 30 days out

    await sweepDriverLicenses();

    const [row] = await db.select().from(driverLicenses).where(eq(driverLicenses.bookingId, b.id));
    expect(row).toBeDefined();
    expect(row!.nameOnLicense).toBe("Jane Driver");
  });

  it("is idempotent: a second run finds nothing new to purge", async () => {
    const b = await mkBooking("completed", -200 * DAY);
    await mkLicense(b.id, new Date(Date.now() - DAY));

    const first = await sweepDriverLicenses();
    expect(first).toBeGreaterThanOrEqual(1);
    const second = await sweepDriverLicenses();
    expect(second).toBe(0);
  });

  it("never touches a licence on a booking that is not completed, even if retainUntil has lapsed", async () => {
    // Models a live/extended booking whose endAt moved out after retainUntil
    // was first computed: the timer looks expired, but the rental is still on.
    const b = await mkBooking("confirmed", 10 * DAY);
    await mkLicense(b.id, new Date(Date.now() - DAY));

    await sweepDriverLicenses();

    const [row] = await db.select().from(driverLicenses).where(eq(driverLicenses.bookingId, b.id));
    expect(row).toBeDefined();
  });
});
