import { describe, it, expect, beforeAll } from "vitest";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { vehicles, settings, customers, bookings, payments } from "@/lib/db/schema";
import { getBookingDetail } from "@/lib/admin/booking-detail";
import { atAruba, parseTs } from "@/lib/time/format";

let db: Awaited<ReturnType<typeof getDb>>;
let vehicleId = "", customerId = "";

// Reads come back as Postgres text (a different literal offset than what we
// inserted), so compare the underlying instant, never the raw string.
const sameInstant = (a: string, b: string) => parseTs(a) === parseTs(b);

// Far-future window: whatever day this suite runs, "now" is always well
// outside the 48h cancellation window, so policySaysFree is deterministically true.
const startAt = atAruba("2033-09-08", "09:00");
const endAt = atAruba("2033-09-11", "09:00");
const bufferEndAt = atAruba("2033-09-12", "09:00");

const breakdown = {
  days: 3, vehicleCents: 17400, insuranceCents: 0, addOns: [], addOnsCents: 0,
  subtotalCents: 17400, depositCents: 25000, youngDriverCents: 0, depositPercent: 25, depositMinCents: 3000, currency: "USD",
};

beforeAll(async () => {
  db = await getDb();
  await runMigrations();
  await db.insert(settings).values({ id: 1 }).onConflictDoNothing();
  const [v] = await db.insert(vehicles).values({
    slug: "bd-car", plate: "PL-BD-CAR", class: "SUV", name: "Detail Car", seats: 5, transmission: "Automatic",
    doors: 5, priceDayCents: 5800, priceWeekCents: 34800, priceMonthCents: 118000, depositCents: 25000,
  }).returning();
  const [c] = await db.insert(customers).values({ email: "bd@test.com", name: "Dana Detail", phone: "+297 555 1212" }).returning();
  vehicleId = v!.id; customerId = c!.id;
});

describe("getBookingDetail", () => {
  it("returns booking + customer + vehicle + payments with computed balance and policy", async () => {
    const [b] = await db.insert(bookings).values({
      vehicleId, customerId, startAt, endAt, bufferEndAt,
      status: "confirmed", source: "online", notes: "Bring extra charger",
      priceBreakdown: breakdown, paymentOption: "deposit",
      acceptedPolicyVersion: 1, acceptedAt: new Date(), idempotencyKey: "bd-detail-1",
      amountPaidCents: 5000,
    }).returning();

    const [p] = await db.insert(payments).values({
      bookingId: b!.id, stripeCheckoutSessionId: "cs_bd_1", stripePaymentIntentId: "pi_bd_1",
      type: "rental_deposit", method: "stripe", amountCents: 5000, currency: "USD", status: "succeeded",
    }).returning();

    const detail = await getBookingDetail(b!.id);

    expect(detail).toBeDefined();
    expect(detail!.booking).toMatchObject({
      id: b!.id, status: "confirmed", source: "online",
      paymentOption: "deposit", notes: "Bring extra charger", amountPaidCents: 5000,
    });
    expect(sameInstant(detail!.booking.startAt, startAt)).toBe(true);
    expect(sameInstant(detail!.booking.endAt, endAt)).toBe(true);
    expect(detail!.booking.priceBreakdown).toMatchObject(breakdown);
    expect(detail!.customer).toEqual({ name: "Dana Detail", email: "bd@test.com", phone: "+297 555 1212" });
    expect(detail!.vehicle).toEqual({ id: vehicleId, name: "Detail Car", plate: "PL-BD-CAR" });

    expect(detail!.payments).toHaveLength(1);
    expect(detail!.payments[0]).toMatchObject({
      id: p!.id, type: "rental_deposit", method: "stripe",
      amountCents: 5000, refundedCents: 0, status: "succeeded", stripePaymentIntentId: "pi_bd_1",
    });
    expect(typeof detail!.payments[0]!.createdAt).toBe("string");

    // subtotal 17400 - amountPaid 5000 = 12400
    expect(detail!.balanceDueCents).toBe(12400);
    expect(detail!.policySaysFree).toBe(true);
  });

  it("floors balanceDueCents at 0 when amountPaidCents exceeds the subtotal (e.g. an extension payment)", async () => {
    const [b] = await db.insert(bookings).values({
      vehicleId, customerId, startAt: atAruba("2034-01-08", "09:00"), endAt: atAruba("2034-01-11", "09:00"),
      bufferEndAt: atAruba("2034-01-12", "09:00"),
      status: "confirmed", source: "online", notes: null,
      priceBreakdown: breakdown, paymentOption: "full",
      acceptedPolicyVersion: 1, acceptedAt: new Date(), idempotencyKey: "bd-detail-2",
      amountPaidCents: 20000, // more than the 17400 subtotal
    }).returning();

    const detail = await getBookingDetail(b!.id);
    expect(detail!.balanceDueCents).toBe(0);
  });

  it("returns undefined for an unknown booking id", async () => {
    const detail = await getBookingDetail("00000000-0000-0000-0000-000000000000");
    expect(detail).toBeUndefined();
  });
});
