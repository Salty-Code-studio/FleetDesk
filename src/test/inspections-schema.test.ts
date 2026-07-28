import { describe, it, expect, beforeAll } from "vitest";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { vehicles, customers, bookings, payments, adminUsers, inspections } from "@/lib/db/schema";
import { expectReject } from "./util";

let db: Awaited<ReturnType<typeof getDb>>;
let vehicleId = "", customerId = "", adminId = "", bookingId = "";

beforeAll(async () => {
  db = await getDb();
  await runMigrations();
  const [v] = await db.insert(vehicles).values({
    slug: "insp-car", plate: "PL-insp", class: "SUV", name: "Insp Car", seats: 5,
    transmission: "Automatic", doors: 5, priceDayCents: 10000, priceWeekCents: 60000,
    priceMonthCents: 200000, depositCents: 25000,
  }).returning();
  const [c] = await db.insert(customers).values({ email: "insp-schema@test.com" }).returning();
  const [a] = await db.insert(adminUsers).values({ email: "insp-schema-admin@test.com", passwordHash: "x" }).returning();
  vehicleId = v!.id; customerId = c!.id; adminId = a!.id;
  const [b] = await db.insert(bookings).values({
    vehicleId, customerId,
    startAt: "2026-08-01T13:00:00Z",
    endAt: "2026-08-05T13:00:00Z",
    bufferEndAt: "2026-08-06T13:00:00Z",
    status: "confirmed",
    priceBreakdown: { subtotalCents: 40000, currency: "USD" },
    paymentOption: "deposit", acceptedPolicyVersion: 1, acceptedAt: new Date(),
    idempotencyKey: "insp-schema-1",
  }).returning();
  bookingId = b!.id;
});

describe("inspections table", () => {
  it("stores a pickup inspection with checklist defaults", async () => {
    const [row] = await db.insert(inspections).values({ bookingId, kind: "pickup", createdBy: adminId }).returning();
    expect(row!.agreementSigned).toBe(false);
    expect(row!.rulesSigned).toBe(false);
    expect(row!.licenseCopyReceived).toBe(false);
    expect(row!.keysReturned).toBe(false);
    expect(row!.photos).toEqual([]);
    expect(row!.damageFlags).toEqual([]);
    expect(row!.borgReceivedCents).toBeNull();
  });

  it("enforces ONE inspection per booking per kind", async () => {
    await expectReject(
      db.insert(inspections).values({ bookingId, kind: "pickup", createdBy: adminId }),
      /inspections_booking_kind|duplicate key/i,
    );
  });

  it("rejects a fuel level outside 0..8", async () => {
    await expectReject(
      db.insert(inspections).values({ bookingId, kind: "return", createdBy: adminId, fuelLevel: 9 }),
      /inspections_fuel_level|check constraint/i,
    );
  });

  it("accepts a desk 'balance' payment row (new enum value)", async () => {
    const [p] = await db.insert(payments).values({
      bookingId, type: "balance", method: "desk", amountCents: 1000, currency: "USD", status: "succeeded",
    }).returning();
    expect(p!.type).toBe("balance");
    expect(p!.method).toBe("desk");
  });
});
