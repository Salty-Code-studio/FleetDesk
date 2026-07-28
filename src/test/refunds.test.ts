import { describe, it, expect, vi, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { vehicles, customers, bookings, payments } from "@/lib/db/schema";
import { refundPayment } from "@/lib/payments/refunds";
import { atAruba } from "@/lib/time/format";

// The repo has no shared Stripe test double yet (existing suites either avoid
// the network path entirely or verify local signature math only), so this
// suite mocks the one module every Stripe call in the app funnels through.
const stripeRefundCreate = vi.fn(async () => ({ id: "re_test" }));
vi.mock("@/lib/payments/stripe-client", () => ({
  getStripe: () => ({ refunds: { create: stripeRefundCreate } }),
}));

let db: Awaited<ReturnType<typeof getDb>>;
let vehicleId = "", customerId = "";

const breakdown = {
  days: 7, vehicleCents: 34800, insuranceCents: 0, addOns: [], addOnsCents: 0,
  subtotalCents: 34800, depositCents: 25000, youngDriverCents: 0, depositPercent: 0, depositMinCents: 3000, currency: "USD",
};

let dateCursor = 1;
// distinct non-overlapping dates per booking (same vehicle, buffered constraint).
function nextWindow() {
  const idx = dateCursor++;
  const year = 2031 + Math.floor((idx - 1) / 12);
  const month = String(((idx - 1) % 12) + 1).padStart(2, "0");
  return {
    startAt: atAruba(`${year}-${month}-01`, "09:00"),
    endAt: atAruba(`${year}-${month}-08`, "09:00"),
    bufferEndAt: atAruba(`${year}-${month}-09`, "09:00"),
  };
}

async function makeBooking(key: string, amountPaidCents: number) {
  const { startAt, endAt, bufferEndAt } = nextWindow();
  const [b] = await db.insert(bookings).values({
    vehicleId, customerId,
    startAt, endAt, bufferEndAt,
    status: "confirmed", priceBreakdown: breakdown, paymentOption: "deposit",
    acceptedPolicyVersion: 1, acceptedAt: new Date(), idempotencyKey: key,
    amountPaidCents,
  }).returning();
  return b!;
}

let sessionCursor = 1;
async function makePayment(opts: {
  bookingId: string;
  amountCents: number;
  refundedCents?: number;
  status?: "pending" | "succeeded" | "failed" | "refunded";
  stripePaymentIntentId: string | null;
}) {
  const [p] = await db.insert(payments).values({
    bookingId: opts.bookingId,
    stripeCheckoutSessionId: `cs_refund_${sessionCursor++}`,
    stripePaymentIntentId: opts.stripePaymentIntentId,
    type: "rental_deposit",
    method: "stripe",
    amountCents: opts.amountCents,
    refundedCents: opts.refundedCents ?? 0,
    currency: "USD",
    status: opts.status ?? "succeeded",
  }).returning();
  return p!;
}

beforeAll(async () => {
  db = await getDb();
  await runMigrations();
  const [v] = await db.insert(vehicles).values({
    slug: "rf-car", plate: "PL-rf-car", class: "SUV", name: "RF Car", seats: 5, transmission: "Automatic",
    doors: 5, priceDayCents: 5800, priceWeekCents: 34800, priceMonthCents: 118000, depositCents: 25000,
  }).returning();
  const [c] = await db.insert(customers).values({ email: "rf@test.com" }).returning();
  vehicleId = v!.id; customerId = c!.id;
});

describe("refundPayment", () => {
  it("refunds a succeeded payment in full by default and marks the row refunded", async () => {
    const b = await makeBooking("rf-1", 3000);
    const payment = await makePayment({ bookingId: b.id, amountCents: 3000, stripePaymentIntentId: "pi_r1" });

    const r = await refundPayment(payment.id);

    expect(stripeRefundCreate).toHaveBeenCalledWith({ payment_intent: "pi_r1", amount: 3000 });
    expect(r.refundedCents).toBe(3000);
    expect(r.status).toBe("refunded");
    expect(r.appliedCents).toBe(3000); // the delta THIS call applied, callers must use this (not before/after math)

    const [after] = await db.select().from(bookings).where(eq(bookings.id, b.id));
    expect(after!.amountPaidCents).toBe(0);
  });

  it("partial refund keeps status succeeded and accumulates refundedCents", async () => {
    const b = await makeBooking("rf-2", 5000);
    const payment = await makePayment({ bookingId: b.id, amountCents: 5000, stripePaymentIntentId: "pi_r2" });

    const r = await refundPayment(payment.id, { amountCents: 1000 });
    expect(r.refundedCents).toBe(1000);
    expect(r.status).toBe("succeeded");
    expect(r.appliedCents).toBe(1000);

    // A second partial refund accumulates on top of the first: refundedCents
    // is the new absolute total, appliedCents is just this call's delta.
    const r2 = await refundPayment(payment.id, { amountCents: 1500 });
    expect(r2.refundedCents).toBe(2500);
    expect(r2.status).toBe("succeeded");
    expect(r2.appliedCents).toBe(1500);

    const [after] = await db.select().from(bookings).where(eq(bookings.id, b.id));
    expect(after!.amountPaidCents).toBe(5000 - 2500);
  });

  it("rejects refunding more than the remaining amount", async () => {
    const b = await makeBooking("rf-3", 2000);
    const payment = await makePayment({ bookingId: b.id, amountCents: 2000, stripePaymentIntentId: "pi_r3" });

    await expect(refundPayment(payment.id, { amountCents: 99999 })).rejects.toMatchObject({ status: 400 });
  });

  it("rejects non-succeeded payments", async () => {
    const b = await makeBooking("rf-4", 0);
    const payment = await makePayment({ bookingId: b.id, amountCents: 3000, status: "pending", stripePaymentIntentId: "pi_r4" });

    await expect(refundPayment(payment.id)).rejects.toMatchObject({ status: 409 });
  });
});
