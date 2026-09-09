import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { vehicles, customers, bookings, payments, adminUsers } from "@/lib/db/schema";
import { setBookingPrice } from "@/lib/admin/set-booking-price";

let db: Awaited<ReturnType<typeof getDb>>;
let vehicleId = "", customerId = "", adminId = "";
let seq = 1;

const QUOTED = {
  days: 4, vehicleCents: 40000, insuranceCents: 5000,
  addOns: [], addOnsCents: 0, subtotalCents: 45000, currency: "USD",
};

async function mkBooking(opts: {
  status?: "pending" | "confirmed" | "picked_up" | "completed" | "cancelled";
  amountPaidCents?: number;
  breakdown?: Record<string, unknown>;
} = {}) {
  const m = String(seq++).padStart(2, "0");
  const [b] = await db.insert(bookings).values({
    vehicleId, customerId,
    startAt: `2027-${m}-01T13:00:00Z`,
    endAt: `2027-${m}-05T13:00:00Z`,
    bufferEndAt: `2027-${m}-06T13:00:00Z`,
    status: opts.status ?? "confirmed",
    priceBreakdown: opts.breakdown ?? QUOTED,
    amountPaidCents: opts.amountPaidCents ?? 0,
    paymentOption: "full", acceptedPolicyVersion: 1, acceptedAt: new Date(),
    idempotencyKey: `setprice-${m}`,
  }).returning();
  return b!;
}

const owner = (over: Partial<{ subtotalCents: number; reason: string }> = {}) => ({
  subtotalCents: 38000, reason: "settled against key work", adminId, role: "owner" as const, ...over,
});

beforeAll(async () => {
  db = await getDb();
  await runMigrations();
  const [v] = await db.insert(vehicles).values({
    slug: "sp-car", plate: "PL-sp", class: "SUV", name: "Set Price Car", seats: 5,
    transmission: "Automatic", doors: 5, priceDayCents: 10000, priceWeekCents: 60000,
    priceMonthCents: 200000,
  }).returning();
  const [c] = await db.insert(customers).values({ email: "setprice@test.com" }).returning();
  const [a] = await db.insert(adminUsers).values({ email: "setprice-admin@test.com", passwordHash: "x" }).returning();
  vehicleId = v!.id; customerId = c!.id; adminId = a!.id;
});

describe("setBookingPrice: the happy path", () => {
  it("rewrites the subtotal, keeps the quote, and stamps the reason", async () => {
    const b = await mkBooking();
    const r = await setBookingPrice(b.id, owner());
    expect(r.previousSubtotalCents).toBe(45000);
    expect(r.newSubtotalCents).toBe(38000);

    const bd = r.booking.priceBreakdown as Record<string, unknown>;
    expect(bd.subtotalCents).toBe(38000);
    expect(bd.adjustmentCents).toBe(-7000);
    expect(bd.vehicleCents).toBe(40000); // original lines survive
    expect((bd.priceOverride as { reason: string }).reason).toBe("settled against key work");
    expect((bd.priceOverride as { byAdminId: string }).byAdminId).toBe(adminId);
  });

  it("allows a price of exactly zero", async () => {
    const b = await mkBooking();
    const r = await setBookingPrice(b.id, owner({ subtotalCents: 0 }));
    expect((r.booking.priceBreakdown as { subtotalCents: number }).subtotalCents).toBe(0);
  });

  it("works on a completed rental, which is when corrections usually happen", async () => {
    const b = await mkBooking({ status: "completed" });
    const r = await setBookingPrice(b.id, owner());
    expect(r.newSubtotalCents).toBe(38000);
  });

  it("writes nothing to the payments ledger", async () => {
    const b = await mkBooking();
    await setBookingPrice(b.id, owner());
    const rows = await db.select().from(payments).where(eq(payments.bookingId, b.id));
    expect(rows).toHaveLength(0);
  });
});

describe("setBookingPrice: guards", () => {
  it("rejects staff with 403 and writes nothing", async () => {
    const b = await mkBooking();
    await expect(setBookingPrice(b.id, { ...owner(), role: "staff" })).rejects.toMatchObject({ status: 403 });
    const [after] = await db.select().from(bookings).where(eq(bookings.id, b.id));
    expect((after!.priceBreakdown as { subtotalCents: number }).subtotalCents).toBe(45000);
  });

  it("rejects a price below what has already been settled", async () => {
    const b = await mkBooking({ amountPaidCents: 40000 });
    await expect(setBookingPrice(b.id, owner({ subtotalCents: 30000 })))
      .rejects.toThrow(/already been paid|record a refund/i);
  });

  it("allows a price exactly equal to what has been settled", async () => {
    const b = await mkBooking({ amountPaidCents: 40000 });
    const r = await setBookingPrice(b.id, owner({ subtotalCents: 40000 }));
    expect(r.newSubtotalCents).toBe(40000);
  });

  it("rejects a cancelled booking", async () => {
    const b = await mkBooking({ status: "cancelled" });
    await expect(setBookingPrice(b.id, owner())).rejects.toThrow(/cancelled/i);
  });

  it("rejects while a payment is still pending", async () => {
    // Online mode computes the Stripe amount from this snapshot at
    // session-create and re-checks it at webhook reconcile; editing in between
    // desyncs the two.
    const b = await mkBooking();
    await db.insert(payments).values({
      bookingId: b.id, type: "rental_full", method: "stripe",
      amountCents: 45000, currency: "USD", status: "pending",
    });
    await expect(setBookingPrice(b.id, owner())).rejects.toThrow(/payment is still open|pending/i);
  });

  it("rejects an unknown booking", async () => {
    await expect(setBookingPrice("00000000-0000-0000-0000-000000000000", owner()))
      .rejects.toMatchObject({ status: 404 });
  });

  it("rejects a blank or too-short reason", async () => {
    const b = await mkBooking();
    await expect(setBookingPrice(b.id, owner({ reason: "  " }))).rejects.toThrow(/reason/i);
  });

  it("rejects a negative price", async () => {
    const b = await mkBooking();
    await expect(setBookingPrice(b.id, owner({ subtotalCents: -100 }))).rejects.toThrow(/cannot be negative/i);
  });
});

describe("setBookingPrice: repeated edits", () => {
  it("keeps measuring the adjustment against the original quote", async () => {
    const b = await mkBooking();
    await setBookingPrice(b.id, owner({ subtotalCents: 38000 }));
    const r = await setBookingPrice(b.id, owner({ subtotalCents: 41000, reason: "corrected again" }));
    const bd = r.booking.priceBreakdown as Record<string, unknown>;
    expect(bd.adjustmentCents).toBe(-4000);
    expect((bd.priceOverride as { previousSubtotalCents: number }).previousSubtotalCents).toBe(45000);
    expect(r.previousSubtotalCents).toBe(38000); // what it was immediately before THIS edit, for the audit row
  });
});
