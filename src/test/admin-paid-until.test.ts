import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { vehicles, customers, bookings } from "@/lib/db/schema";

let db: Awaited<ReturnType<typeof getDb>>;
let vehicleId = "", customerId = "";
let seq = 1;

async function mkBooking(status: "confirmed" | "picked_up" | "cancelled") {
  const m = String(seq++).padStart(2, "0");
  const [b] = await db.insert(bookings).values({
    vehicleId, customerId,
    startAt: `2027-${m}-01T13:00:00Z`,
    endAt: `2027-${m}-25T13:00:00Z`,
    bufferEndAt: `2027-${m}-26T13:00:00Z`,
    status,
    priceBreakdown: { subtotalCents: 120000, currency: "USD" },
    paymentOption: "full", acceptedPolicyVersion: 1, acceptedAt: new Date(),
    idempotencyKey: `paiduntil-${m}`,
  }).returning();
  return b!;
}

beforeAll(async () => {
  db = await getDb();
  await runMigrations();
  const [v] = await db.insert(vehicles).values({
    slug: "pu-car", plate: "PL-pu", class: "SUV", name: "Paid Until Car", seats: 5,
    transmission: "Automatic", doors: 5, priceDayCents: 10000, priceWeekCents: 60000,
    priceMonthCents: 200000,
  }).returning();
  const [c] = await db.insert(customers).values({ email: "paiduntil@test.com" }).returning();
  vehicleId = v!.id; customerId = c!.id;
});

describe("paid_until column", () => {
  it("defaults to null and round-trips a YYYY-MM-DD string", async () => {
    const b = await mkBooking("picked_up");
    expect(b.paidUntil).toBeNull();

    await db.update(bookings).set({ paidUntil: "2027-04-30" }).where(eq(bookings.id, b.id));
    const [after] = await db.select().from(bookings).where(eq(bookings.id, b.id));
    expect(after!.paidUntil).toBe("2027-04-30");
  });

  it("clears back to null", async () => {
    const b = await mkBooking("picked_up");
    await db.update(bookings).set({ paidUntil: "2027-05-31" }).where(eq(bookings.id, b.id));
    await db.update(bookings).set({ paidUntil: null }).where(eq(bookings.id, b.id));
    const [after] = await db.select().from(bookings).where(eq(bookings.id, b.id));
    expect(after!.paidUntil).toBeNull();
  });

  it("leaves the money ledger untouched", async () => {
    const b = await mkBooking("picked_up");
    await db.update(bookings).set({ paidUntil: "2027-06-30" }).where(eq(bookings.id, b.id));
    const [after] = await db.select().from(bookings).where(eq(bookings.id, b.id));
    expect(after!.amountPaidCents).toBe(0);
  });
});
