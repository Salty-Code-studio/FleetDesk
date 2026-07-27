import { describe, it, expect, vi, beforeAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { vehicles, settings, customers, bookings, payments, addOns, bookingAddOns } from "@/lib/db/schema";
import { extendBooking } from "@/lib/admin/extend-booking";
import { atAruba } from "@/lib/time/format";

// The link path stands up a Stripe Checkout session; every Stripe call funnels
// through this one module, so we stub it like the other payment tests do.
const stripeSessionCreate = vi.fn(async () => ({ id: "cs_ext_test", url: "https://checkout.stripe.test/ext" }));
vi.mock("@/lib/payments/stripe-client", () => ({
  getStripe: () => ({ checkout: { sessions: { create: stripeSessionCreate } } }),
}));

let db: Awaited<ReturnType<typeof getDb>>;
let customerId = "";
let vehCursor = 0;

async function makeVehicle(rates: { day: number; week: number; month: number }): Promise<string> {
  vehCursor += 1;
  const [v] = await db.insert(vehicles).values({
    slug: `ext-${vehCursor}`, plate: `EXT-${vehCursor}`, class: "SUV", name: `Ext Car ${vehCursor}`,
    seats: 5, transmission: "Automatic", doors: 5,
    priceDayCents: rates.day, priceWeekCents: rates.week, priceMonthCents: rates.month,
  }).returning();
  return v!.id;
}

let keyCursor = 0;
function breakdownFor(days: number, subtotalCents: number, extra: Record<string, unknown> = {}) {
  return {
    days, vehicleCents: subtotalCents, insuranceCents: 0, addOns: [], addOnsCents: 0,
    subtotalCents, depositCents: null, youngDriverCents: 0,
    depositPercent: 25, depositMinCents: 3000, currency: "USD", ...extra,
  };
}

async function makeBooking(opts: {
  vehicleId: string; start: string; end: string; buffer: string;
  breakdown: Record<string, unknown>; amountPaidCents: number;
  status?: "confirmed" | "picked_up" | "pending" | "completed";
  insuranceSnapshot?: unknown;
}) {
  keyCursor += 1;
  const [b] = await db.insert(bookings).values({
    vehicleId: opts.vehicleId, customerId,
    startAt: opts.start, endAt: opts.end, bufferEndAt: opts.buffer,
    status: opts.status ?? "confirmed", priceBreakdown: opts.breakdown, paymentOption: "full",
    amountPaidCents: opts.amountPaidCents,
    insuranceSnapshot: opts.insuranceSnapshot ?? null,
    acceptedPolicyVersion: 1, acceptedAt: new Date(), idempotencyKey: `ext-${keyCursor}`,
  }).returning();
  return b!;
}

beforeAll(async () => {
  db = await getDb();
  await runMigrations();
  await db.insert(settings).values({ id: 1 }).onConflictDoNothing();
  const [c] = await db.insert(customers).values({ email: "ext@test.com" }).returning();
  customerId = c!.id;
});

describe("extendBooking", () => {
  it("extends a confirmed booking, reprices the full duration, returns the delta (desk)", async () => {
    const vehicleId = await makeVehicle({ day: 8000, week: 100000, month: 400000 });
    const b = await makeBooking({
      vehicleId,
      start: atAruba("2026-08-01", "09:00"), end: atAruba("2026-08-03", "09:00"), buffer: atAruba("2026-08-04", "09:00"),
      breakdown: breakdownFor(2, 16000), amountPaidCents: 16000,
    });

    const r = await extendBooking(b.id, { endAt: atAruba("2026-08-04", "09:00"), payment: "desk" });

    expect(r.deltaCents).toBe(8000);
    expect(r.booking.endAt).toContain("2026-08-04");
    expect(r.checkoutUrl).toBeNull();

    // desk path: a succeeded extension payment (method desk) exists for the delta
    const [pay] = await db.select().from(payments)
      .where(and(eq(payments.bookingId, b.id), eq(payments.type, "extension")));
    expect(pay?.method).toBe("desk");
    expect(pay?.status).toBe("succeeded");
    expect(pay?.amountCents).toBe(8000);

    // amountPaidCents grew by 8000
    const [after] = await db.select().from(bookings).where(eq(bookings.id, b.id));
    expect(after!.amountPaidCents).toBe(24000);
    expect((after!.priceBreakdown as { subtotalCents: number }).subtotalCents).toBe(24000);
  });

  it("floors the delta at zero when tier pricing makes the longer rental cheaper", async () => {
    // Legacy 6-day snapshot priced at 6 x 8000 = 48000. The vehicle now has a
    // week tier (42000), so a full 7-day re-quote is CHEAPER than the snapshot.
    const vehicleId = await makeVehicle({ day: 8000, week: 42000, month: 400000 });
    const b = await makeBooking({
      vehicleId,
      start: atAruba("2026-08-10", "09:00"), end: atAruba("2026-08-16", "09:00"), buffer: atAruba("2026-08-17", "09:00"),
      breakdown: breakdownFor(6, 48000), amountPaidCents: 48000,
    });

    const r = await extendBooking(b.id, { endAt: atAruba("2026-08-17", "09:00"), payment: "desk" });

    expect(r.deltaCents).toBe(0);
    // no extension payment row for a zero delta
    const rows = await db.select().from(payments)
      .where(and(eq(payments.bookingId, b.id), eq(payments.type, "extension")));
    expect(rows.length).toBe(0);
    // amountPaidCents untouched, dates + re-quote still applied
    const [after] = await db.select().from(bookings).where(eq(bookings.id, b.id));
    expect(after!.amountPaidCents).toBe(48000);
    expect(after!.endAt).toContain("2026-08-17");
    expect((after!.priceBreakdown as { subtotalCents: number }).subtotalCents).toBe(42000);
  });

  it("refuses when another booking occupies the extension window (409)", async () => {
    const vehicleId = await makeVehicle({ day: 8000, week: 100000, month: 400000 });
    const b = await makeBooking({
      vehicleId,
      start: atAruba("2026-08-20", "09:00"), end: atAruba("2026-08-22", "09:00"), buffer: atAruba("2026-08-23", "09:00"),
      breakdown: breakdownFor(2, 16000), amountPaidCents: 16000,
    });
    // Another booking sits just after b on the same car.
    await makeBooking({
      vehicleId,
      start: atAruba("2026-08-25", "09:00"), end: atAruba("2026-08-27", "09:00"), buffer: atAruba("2026-08-28", "09:00"),
      breakdown: breakdownFor(2, 16000), amountPaidCents: 16000,
    });

    await expect(extendBooking(b.id, { endAt: atAruba("2026-08-26", "09:00"), payment: "desk" }))
      .rejects.toMatchObject({ status: 409 });

    // b unchanged after the refusal
    const [after] = await db.select().from(bookings).where(eq(bookings.id, b.id));
    expect(after!.endAt).toContain("2026-08-22");
  });

  it("link path returns a checkout url and a pending extension payment row", async () => {
    const vehicleId = await makeVehicle({ day: 8000, week: 100000, month: 400000 });
    const b = await makeBooking({
      vehicleId,
      start: atAruba("2026-09-01", "09:00"), end: atAruba("2026-09-03", "09:00"), buffer: atAruba("2026-09-04", "09:00"),
      breakdown: breakdownFor(2, 16000), amountPaidCents: 16000,
    });

    const r = await extendBooking(b.id, { endAt: atAruba("2026-09-04", "09:00"), payment: "link" });

    expect(r.deltaCents).toBe(8000);
    expect(r.checkoutUrl).toMatch(/^https:/);

    // a PENDING extension payment (stripe) exists; the webhook settles it later
    const [pay] = await db.select().from(payments)
      .where(and(eq(payments.bookingId, b.id), eq(payments.type, "extension")));
    expect(pay?.method).toBe("stripe");
    expect(pay?.status).toBe("pending");
    expect(pay?.amountCents).toBe(8000);

    // link path does NOT credit amountPaidCents until the webhook confirms
    const [after] = await db.select().from(bookings).where(eq(bookings.id, b.id));
    expect(after!.amountPaidCents).toBe(16000);
    expect(after!.endAt).toContain("2026-09-04");
  });

  it("refuses statuses other than confirmed and picked_up", async () => {
    const vehicleId = await makeVehicle({ day: 8000, week: 100000, month: 400000 });
    const pending = await makeBooking({
      vehicleId, status: "pending",
      start: atAruba("2026-10-01", "09:00"), end: atAruba("2026-10-03", "09:00"), buffer: atAruba("2026-10-04", "09:00"),
      breakdown: breakdownFor(2, 16000), amountPaidCents: 0,
    });
    await expect(extendBooking(pending.id, { endAt: atAruba("2026-10-04", "09:00"), payment: "desk" }))
      .rejects.toMatchObject({ status: 409 });

    const vehicleId2 = await makeVehicle({ day: 8000, week: 100000, month: 400000 });
    const completed = await makeBooking({
      vehicleId: vehicleId2, status: "completed",
      start: atAruba("2026-10-10", "09:00"), end: atAruba("2026-10-12", "09:00"), buffer: atAruba("2026-10-13", "09:00"),
      breakdown: breakdownFor(2, 16000), amountPaidCents: 16000,
    });
    await expect(extendBooking(completed.id, { endAt: atAruba("2026-10-13", "09:00"), payment: "desk" }))
      .rejects.toMatchObject({ status: 409 });
  });

  it("allows extending a picked_up booking", async () => {
    const vehicleId = await makeVehicle({ day: 8000, week: 100000, month: 400000 });
    const b = await makeBooking({
      vehicleId, status: "picked_up",
      start: atAruba("2026-11-01", "09:00"), end: atAruba("2026-11-03", "09:00"), buffer: atAruba("2026-11-04", "09:00"),
      breakdown: breakdownFor(2, 16000), amountPaidCents: 16000,
    });
    const r = await extendBooking(b.id, { endAt: atAruba("2026-11-04", "09:00"), payment: "desk" });
    expect(r.deltaCents).toBe(8000);
    expect(r.booking.status).toBe("picked_up");
  });

  it("rejects a new return that is not after the current return (400)", async () => {
    const vehicleId = await makeVehicle({ day: 8000, week: 100000, month: 400000 });
    const b = await makeBooking({
      vehicleId,
      start: atAruba("2026-12-01", "09:00"), end: atAruba("2026-12-03", "09:00"), buffer: atAruba("2026-12-04", "09:00"),
      breakdown: breakdownFor(2, 16000), amountPaidCents: 16000,
    });
    await expect(extendBooking(b.id, { endAt: atAruba("2026-12-03", "09:00"), payment: "desk" }))
      .rejects.toMatchObject({ status: 400 });
  });

  it("reprices insurance and add-ons using the locked-in snapshot units, not the current catalog", async () => {
    const vehicleId = await makeVehicle({ day: 8000, week: 100000, month: 400000 });
    // Catalog prices are RAISED after booking; the re-quote must ignore them and
    // keep the customer's snapshot unit prices.
    const [perDay] = await db.insert(addOns).values({
      name: "Baby seat", priceCents: 9999, pricing: "per_day",
    }).returning();
    const [perRental] = await db.insert(addOns).values({
      name: "GPS", priceCents: 9999, pricing: "per_rental",
    }).returning();

    // Old snapshot: 2 days. vehicle 16000 + insurance 2*1500=3000
    //   + baby seat per_day 1000*2*1=2000 + GPS per_rental 500*2=1000 = 22000
    const b = await makeBooking({
      vehicleId,
      start: atAruba("2027-01-01", "09:00"), end: atAruba("2027-01-03", "09:00"), buffer: atAruba("2027-01-04", "09:00"),
      breakdown: {
        days: 2, vehicleCents: 16000, insuranceCents: 3000,
        addOns: [
          { id: perDay!.id, name: "Baby seat", qty: 1, cents: 2000 },
          { id: perRental!.id, name: "GPS", qty: 2, cents: 1000 },
        ],
        addOnsCents: 3000, subtotalCents: 22000, depositCents: null, youngDriverCents: 0,
        depositPercent: 25, depositMinCents: 3000, currency: "USD",
      },
      amountPaidCents: 22000,
      insuranceSnapshot: { id: "ins-1", name: "Full", dailyPriceCents: 1500 },
    });
    await db.insert(bookingAddOns).values([
      { bookingId: b.id, addOnId: perDay!.id, qty: 1, priceSnapshotCents: 2000 },
      { bookingId: b.id, addOnId: perRental!.id, qty: 2, priceSnapshotCents: 1000 },
    ]);

    // Extend to 3 days: vehicle 24000 + insurance 3*1500=4500
    //   + baby seat per_day 1000*3*1=3000 + GPS per_rental 500*2=1000 = 32500
    const r = await extendBooking(b.id, { endAt: atAruba("2027-01-04", "09:00"), payment: "desk" });
    expect(r.deltaCents).toBe(10500);

    const bd = r.booking.priceBreakdown as { subtotalCents: number; insuranceCents: number; addOns: { id: string; cents: number }[] };
    expect(bd.subtotalCents).toBe(32500);
    expect(bd.insuranceCents).toBe(4500);
    expect(bd.addOns.find((a) => a.id === perDay!.id)?.cents).toBe(3000);
    expect(bd.addOns.find((a) => a.id === perRental!.id)?.cents).toBe(1000);

    // per-day add-on snapshot refreshed to the new duration
    const [snap] = await db.select().from(bookingAddOns)
      .where(and(eq(bookingAddOns.bookingId, b.id), eq(bookingAddOns.addOnId, perDay!.id)));
    expect(snap!.priceSnapshotCents).toBe(3000);
  });
});
