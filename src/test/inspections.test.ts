import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { vehicles, customers, bookings, payments, adminUsers } from "@/lib/db/schema";
import { assertBookingTransition } from "@/lib/booking/transitions";
import { upsertInspection, recordDeskBalancePayment, getHandover } from "@/lib/admin/inspections";
import { cancelBookingAdmin } from "@/lib/admin/move-booking";

let db: Awaited<ReturnType<typeof getDb>>;
let vehicleId = "", customerId = "", adminId = "";
let month = 1;

async function mkBooking(key: string, status: "pending" | "confirmed" | "picked_up" | "completed" | "cancelled") {
  const m = String(month++).padStart(2, "0");
  const [b] = await db.insert(bookings).values({
    vehicleId, customerId,
    // startAt/endAt/bufferEndAt are `mode: "string"` timestamptz columns in this
    // codebase, so they take ISO strings (not Date objects).
    startAt: `2027-${m}-01T13:00:00Z`,
    endAt: `2027-${m}-05T13:00:00Z`,
    bufferEndAt: `2027-${m}-06T13:00:00Z`,
    status,
    priceBreakdown: { subtotalCents: 40000, vehicleCents: 40000, insuranceCents: 0, addOns: [], addOnsCents: 0, days: 4, currency: "USD" },
    paymentOption: "deposit", acceptedPolicyVersion: 1, acceptedAt: new Date(),
    idempotencyKey: key,
  }).returning();
  return b!;
}

beforeAll(async () => {
  db = await getDb();
  await runMigrations();
  const [v] = await db.insert(vehicles).values({
    slug: "insp-lib-car", plate: "PL-insp-lib", class: "SUV", name: "Insp Lib Car", seats: 5,
    transmission: "Automatic", doors: 5, priceDayCents: 10000, priceWeekCents: 60000,
    priceMonthCents: 200000, depositCents: 25000,
  }).returning();
  const [c] = await db.insert(customers).values({ email: "insp-lib@test.com" }).returning();
  const [a] = await db.insert(adminUsers).values({ email: "insp-lib-admin@test.com", passwordHash: "x" }).returning();
  vehicleId = v!.id; customerId = c!.id; adminId = a!.id;
});

describe("assertBookingTransition", () => {
  it("allows the wave's lifecycle and nothing else", () => {
    expect(() => assertBookingTransition("confirmed", "picked_up")).not.toThrow();
    expect(() => assertBookingTransition("pending", "picked_up")).not.toThrow();
    expect(() => assertBookingTransition("picked_up", "completed")).not.toThrow();
    expect(() => assertBookingTransition("picked_up", "cancelled")).toThrow();
    expect(() => assertBookingTransition("completed", "picked_up")).toThrow();
    expect(() => assertBookingTransition("cancelled", "picked_up")).toThrow();
    expect(() => assertBookingTransition("confirmed", "completed")).toThrow();
  });
});

describe("upsertInspection", () => {
  it("creates the row on first write and patches on later writes", async () => {
    const b = await mkBooking("insp-upsert-1", "confirmed");
    const first = await upsertInspection(b.id, "pickup", { odometer: 41250 }, adminId);
    expect(first.after.odometer).toBe(41250);
    expect(first.after.agreementSigned).toBe(false);
    const second = await upsertInspection(b.id, "pickup", { agreementSigned: true, fuelLevel: 6 }, adminId);
    expect(second.before?.odometer).toBe(41250);
    expect(second.after.agreementSigned).toBe(true);
    expect(second.after.fuelLevel).toBe(6);
    expect(second.after.id).toBe(first.after.id); // same row, no duplicate
  });

  it("rejects a return inspection before the car is out", async () => {
    const b = await mkBooking("insp-upsert-2", "confirmed");
    await expect(upsertInspection(b.id, "return", { odometer: 1 }, adminId)).rejects.toThrow(/check the car in/i);
  });

  it("rejects inspections on a cancelled booking", async () => {
    const b = await mkBooking("insp-upsert-3", "cancelled");
    await expect(upsertInspection(b.id, "pickup", { odometer: 1 }, adminId)).rejects.toThrow(/cancelled/i);
  });
});

describe("recordDeskBalancePayment", () => {
  it("adds a desk 'balance' payment and bumps amountPaidCents", async () => {
    const b = await mkBooking("insp-desk-1", "confirmed");
    const updated = await recordDeskBalancePayment(b.id, 40000, adminId);
    expect(updated.amountPaidCents).toBe(40000);
    const rows = await db.select().from(payments).where(eq(payments.bookingId, b.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe("balance");
    expect(rows[0]!.method).toBe("desk");
    expect(rows[0]!.status).toBe("succeeded");
  });

  it("refuses to collect more than the open balance", async () => {
    const b = await mkBooking("insp-desk-2", "confirmed");
    await expect(recordDeskBalancePayment(b.id, 40001, adminId)).rejects.toThrow(/more than the open balance/i);
  });
});

describe("getHandover", () => {
  it("returns booking, vehicle, customer, balance, and inspection slots", async () => {
    const b = await mkBooking("insp-handover-1", "confirmed");
    await upsertInspection(b.id, "pickup", { odometer: 5 }, adminId);
    const h = await getHandover(b.id);
    expect(h.booking.id).toBe(b.id);
    expect(h.booking.balanceDueCents).toBe(40000);
    expect(h.vehicle.plate).toBe("PL-insp-lib");
    expect(h.customer.email).toBe("insp-lib@test.com");
    expect(h.inspections.pickup?.odometer).toBe(5);
    expect(h.inspections.return).toBeNull();
    expect(h.license).toBeNull();
    expect(h.booking.priceLines[0]!.cents).toBe(40000);
  });
});

describe("cancelBookingAdmin transition guard", () => {
  it("refuses to cancel a picked_up booking (the car is out)", async () => {
    const b = await mkBooking("insp-cancel-1", "picked_up");
    // cancelBookingAdmin(id, refund, nowIso) — plan 02's refund-flow signature.
    await expect(cancelBookingAdmin(b.id, false, new Date().toISOString())).rejects.toThrow(/no longer be cancelled/i);
  });
});
