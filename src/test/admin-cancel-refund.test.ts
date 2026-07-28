import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { vehicles, settings, customers, bookings, payments } from "@/lib/db/schema";
import { cancelBookingAdmin } from "@/lib/admin/move-booking";
import { atAruba } from "@/lib/time/format";

// Same Stripe test double idiom as refunds.test.ts / customer-cancel-policy.test.ts:
// every Stripe call in the app funnels through this one module.
const stripeRefundCreate = vi.fn(async () => ({ id: "re_test" }));
vi.mock("@/lib/payments/stripe-client", () => ({
  getStripe: () => ({ refunds: { create: stripeRefundCreate } }),
}));

// Injects a "concurrent refund" that lands between cancelBookingAdmin's
// pre-transaction select and its call into refundPayment, so the regression
// test below can prove the returned/emailed refundCents comes from
// refundPayment's own applied delta and not a stale pre-read. When
// raceAmountCents is 0 (every other test in this file) this is a transparent
// passthrough to the real refundPayment.
let raceAmountCents = 0;
vi.mock("@/lib/payments/refunds", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/payments/refunds")>();
  return {
    ...actual,
    refundPayment: async (paymentId: string, opts?: { amountCents?: number }) => {
      if (raceAmountCents > 0) {
        const amount = raceAmountCents;
        raceAmountCents = 0; // fire once per test
        await actual.refundPayment(paymentId, { amountCents: amount }); // the "other admin's" refund
      }
      return actual.refundPayment(paymentId, opts);
    },
  };
});

let db: Awaited<ReturnType<typeof getDb>>;
let vehicleId = "", customerId = "";

const breakdown = {
  days: 7, vehicleCents: 34800, insuranceCents: 0, addOns: [], addOnsCents: 0,
  subtotalCents: 34800, depositCents: 25000, youngDriverCents: 0, depositPercent: 0, depositMinCents: 3000, currency: "USD",
};

let dateCursor = 1;
// distinct non-overlapping windows per booking (same vehicle, buffered constraint).
// Day 08 as the pickup day (not 01) so "3 days before" / "12 hours before" never
// underflow into the previous month.
function nextWindow() {
  const idx = dateCursor++;
  const year = 2033 + Math.floor((idx - 1) / 12);
  const month = String(((idx - 1) % 12) + 1).padStart(2, "0");
  return {
    year, month,
    startAt: atAruba(`${year}-${month}-08`, "09:00"),
    endAt: atAruba(`${year}-${month}-15`, "09:00"),
    bufferEndAt: atAruba(`${year}-${month}-16`, "09:00"),
  };
}

let keyCursor = 1;
async function makeBooking(amountPaidCents: number) {
  const w = nextWindow();
  const [b] = await db.insert(bookings).values({
    vehicleId, customerId,
    startAt: w.startAt, endAt: w.endAt, bufferEndAt: w.bufferEndAt,
    status: "confirmed", priceBreakdown: breakdown, paymentOption: "deposit",
    acceptedPolicyVersion: 1, acceptedAt: new Date(), idempotencyKey: `acr-${keyCursor++}`,
    amountPaidCents,
  }).returning();
  return { booking: b!, window: w };
}

let sessionCursor = 1;
async function makePayment(bookingId: string, amountCents: number) {
  const [p] = await db.insert(payments).values({
    bookingId,
    stripeCheckoutSessionId: `cs_acr_${sessionCursor}`,
    stripePaymentIntentId: `pi_acr_${sessionCursor++}`,
    type: "rental_deposit",
    method: "stripe",
    amountCents,
    currency: "USD",
    status: "succeeded",
  }).returning();
  return p!;
}

beforeAll(async () => {
  db = await getDb();
  await runMigrations();
  await db.insert(settings).values({ id: 1 }).onConflictDoNothing();
  const [v] = await db.insert(vehicles).values({
    slug: "acr-car", plate: "PL-acr-car", class: "SUV", name: "ACR Car", seats: 5, transmission: "Automatic",
    doors: 5, priceDayCents: 5800, priceWeekCents: 34800, priceMonthCents: 118000, depositCents: 25000,
  }).returning();
  const [c] = await db.insert(customers).values({ email: "acr@test.com" }).returning();
  vehicleId = v!.id; customerId = c!.id;
});

beforeEach(() => {
  stripeRefundCreate.mockClear();
  raceAmountCents = 0;
});

describe("admin cancel gains a refund choice", () => {
  it("refund: true refunds the succeeded payment regardless of window (goodwill override)", async () => {
    const { booking, window: w } = await makeBooking(4000);
    const payment = await makePayment(booking.id, 4000);
    // 12h before pickup: strictly INSIDE the 48h window, so policy alone says no refund.
    const nowIso = atAruba(`${w.year}-${w.month}-07`, "21:00");

    const result = await cancelBookingAdmin(booking.id, true, nowIso);

    expect(stripeRefundCreate).toHaveBeenCalledWith({ payment_intent: payment.stripePaymentIntentId, amount: 4000 });
    expect(result.refunded).toBe(true);
    expect(result.refundCents).toBe(4000);
    // the override happened despite the window, not because of it
    expect(result.policySaysFree).toBe(false);
  });

  it("refund: false never calls Stripe, even when the policy would have allowed a refund", async () => {
    const { booking, window: w } = await makeBooking(4000);
    await makePayment(booking.id, 4000);
    // 3 days before pickup: well outside the window, policy would say free.
    const nowIso = atAruba(`${w.year}-${w.month}-05`, "09:00");

    const result = await cancelBookingAdmin(booking.id, false, nowIso);

    expect(stripeRefundCreate).not.toHaveBeenCalled();
    expect(result.refunded).toBe(false);
    expect(result.refundCents).toBe(0);
    expect(result.policySaysFree).toBe(true);
  });

  it("carries policySaysFree computed from the booking + settings, independent of the refund choice", async () => {
    const { booking: freeBooking, window: fw } = await makeBooking(0);
    const freeNow = atAruba(`${fw.year}-${fw.month}-05`, "09:00"); // 3 days before -> free
    const freeResult = await cancelBookingAdmin(freeBooking.id, false, freeNow);
    expect(freeResult.policySaysFree).toBe(true);

    const { booking: lateBooking, window: lw } = await makeBooking(0);
    const lateNow = atAruba(`${lw.year}-${lw.month}-06`, "09:00"); // exactly 48h before startAt (day 08 09:00) -> boundary counts as inside, not free
    const lateResult = await cancelBookingAdmin(lateBooking.id, false, lateNow);
    expect(lateResult.policySaysFree).toBe(false);

    expect(stripeRefundCreate).not.toHaveBeenCalled();
  });

  it("reports the delta refundPayment actually applied, not a stale pre-read, under a concurrent refund", async () => {
    const { booking, window: w } = await makeBooking(5000);
    const payment = await makePayment(booking.id, 5000);
    const nowIso = atAruba(`${w.year}-${w.month}-07`, "21:00"); // inside window, irrelevant: refund:true is a goodwill override

    // Simulate another refund of 1000 cents on this same payment landing in
    // the gap between cancelBookingAdmin's pre-transaction select and its
    // call into refundPayment. The only correct reported/emailed amount for
    // THIS cancellation is the 4000 cents its own refundPayment call
    // applied, not 5000 (which is what you get by diffing against the stale
    // pre-read).
    raceAmountCents = 1000;

    const result = await cancelBookingAdmin(booking.id, true, nowIso);

    expect(result.refundCents).toBe(4000);
    const [after] = await db.select().from(payments).where(eq(payments.id, payment.id));
    expect(after!.refundedCents).toBe(5000); // ledger total is still correct
  });
});
