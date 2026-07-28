import { describe, it, expect, beforeAll, vi } from "vitest";
import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { vehicles, customers, bookings, payments } from "@/lib/db/schema";
import { processStripeEvent } from "@/lib/payments/webhook";
import { getStripe } from "@/lib/payments/stripe-client";
import { env } from "@/env";
import { atAruba } from "@/lib/time/format";

// The surplus auto-refund path calls getStripe().refunds.create; stub it so no
// network is hit, while preserving the REAL webhooks helper the signature test
// below needs (generateTestHeaderString / constructEvent do local HMAC only).
const { stripeRefundCreate } = vi.hoisted(() => ({ stripeRefundCreate: vi.fn(async () => ({ id: "re_test" })) }));
vi.mock("@/lib/payments/stripe-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/payments/stripe-client")>();
  const real = actual.getStripe();
  return { getStripe: () => ({ webhooks: real.webhooks, refunds: { create: stripeRefundCreate } }) };
});

let db: Awaited<ReturnType<typeof getDb>>;
let vehicleId = "", customerId = "";

const breakdown = {
  days: 7, vehicleCents: 34800, insuranceCents: 0, addOns: [], addOnsCents: 0,
  subtotalCents: 34800, depositCents: 25000, youngDriverCents: 0, depositPercent: 0, depositMinCents: 3000, currency: "USD",
};

let dateCursor = 1;
// distinct non-overlapping dates per booking (same vehicle, buffered constraint).
// Wraps into later years once the cursor passes month 12 so many bookings still
// land on valid, non-overlapping windows.
function nextWindow() {
  const idx = dateCursor++;
  const year = 2027 + Math.floor((idx - 1) / 12);
  const month = String(((idx - 1) % 12) + 1).padStart(2, "0");
  return {
    startAt: atAruba(`${year}-${month}-01`, "09:00"),
    endAt: atAruba(`${year}-${month}-08`, "09:00"),
    bufferEndAt: atAruba(`${year}-${month}-09`, "09:00"),
  };
}

async function makePendingBooking(key: string, sessionId: string) {
  const { startAt, endAt, bufferEndAt } = nextWindow();
  const [b] = await db.insert(bookings).values({
    vehicleId, customerId,
    startAt, endAt, bufferEndAt,
    status: "pending", priceBreakdown: breakdown, paymentOption: "deposit",
    acceptedPolicyVersion: 1, acceptedAt: new Date(), idempotencyKey: key,
  }).returning();
  await db.insert(payments).values({
    bookingId: b!.id, stripeCheckoutSessionId: sessionId, type: "reservation_fee",
    amountCents: 3000, currency: "USD", status: "pending",
  });
  return b!;
}

function paidEvent(id: string, sessionId: string, bookingId: string, over: Partial<Stripe.Checkout.Session> = {}, type = "checkout.session.completed"): Stripe.Event {
  return {
    id, type, object: "event", api_version: null,
    created: 0, livemode: false, pending_webhooks: 0, request: null,
    data: { object: {
      id: sessionId, object: "checkout.session", payment_status: "paid",
      amount_total: 3000, currency: "usd", payment_intent: `pi_${sessionId}`,
      metadata: { bookingId }, ...over,
    } as Stripe.Checkout.Session },
  } as Stripe.Event;
}

async function makeBookingNoPayment(key: string) {
  const { startAt, endAt, bufferEndAt } = nextWindow();
  const [b] = await db.insert(bookings).values({
    vehicleId, customerId,
    startAt, endAt, bufferEndAt,
    status: "pending", priceBreakdown: breakdown, paymentOption: "deposit",
    acceptedPolicyVersion: 1, acceptedAt: new Date(), idempotencyKey: key,
  }).returning();
  return b!;
}

beforeAll(async () => {
  db = await getDb();
  await runMigrations();
  const [v] = await db.insert(vehicles).values({
    slug: "wh-car", plate: "PL-wh-car", class: "SUV", name: "WH Car", seats: 5, transmission: "Automatic",
    doors: 5, priceDayCents: 5800, priceWeekCents: 34800, priceMonthCents: 118000, depositCents: 25000,
  }).returning();
  const [c] = await db.insert(customers).values({ email: "wh@test.com" }).returning();
  vehicleId = v!.id; customerId = c!.id;
});

describe("processStripeEvent", () => {
  it("confirms the booking and marks the payment succeeded on a paid event", async () => {
    const b = await makePendingBooking("wh-1", "cs_test_1");
    const res = await processStripeEvent(paidEvent("evt_1", "cs_test_1", b.id));
    expect(res.bookingConfirmed).toBe(true);
    const [after] = await db.select().from(bookings).where(eq(bookings.id, b.id));
    expect(after!.status).toBe("confirmed");
    const [pay] = await db.select().from(payments).where(eq(payments.stripeCheckoutSessionId, "cs_test_1"));
    expect(pay!.status).toBe("succeeded");
    expect(pay!.stripePaymentIntentId).toBe("pi_cs_test_1");
  });

  it("is idempotent: the same event id twice confirms once", async () => {
    const b = await makePendingBooking("wh-2", "cs_test_2");
    await processStripeEvent(paidEvent("evt_2", "cs_test_2", b.id));
    const dup = await processStripeEvent(paidEvent("evt_2", "cs_test_2", b.id));
    expect(dup.duplicate).toBe(true);
    const [after] = await db.select().from(bookings).where(eq(bookings.id, b.id));
    expect(after!.status).toBe("confirmed");
  });

  it("does NOT confirm on an amount mismatch", async () => {
    const b = await makePendingBooking("wh-3", "cs_test_3");
    const res = await processStripeEvent(paidEvent("evt_3", "cs_test_3", b.id, { amount_total: 100 }));
    expect(res.bookingConfirmed).toBeFalsy();
    const [after] = await db.select().from(bookings).where(eq(bookings.id, b.id));
    expect(after!.status).toBe("pending");
  });

  it("ignores an unpaid session and unknown event types", async () => {
    const b = await makePendingBooking("wh-4", "cs_test_4");
    const unpaid = await processStripeEvent(paidEvent("evt_4", "cs_test_4", b.id, { payment_status: "unpaid" }));
    expect(unpaid.bookingConfirmed).toBeFalsy();
    const other = await processStripeEvent({ id: "evt_5", type: "customer.created", data: { object: {} } } as Stripe.Event);
    expect(other.handled).toBe(true);
  });

  it("does not resurrect a cancelled booking", async () => {
    const b = await makePendingBooking("wh-6", "cs_test_6");
    await db.update(bookings).set({ status: "cancelled" }).where(eq(bookings.id, b.id));
    const res = await processStripeEvent(paidEvent("evt_6", "cs_test_6", b.id));
    expect(res.bookingConfirmed).toBe(false);
    const [after] = await db.select().from(bookings).where(eq(bookings.id, b.id));
    expect(after!.status).toBe("cancelled");
  });

  it("handles a surplus capture from a second session without colliding on the one-pending index", async () => {
    // Booking confirmed with a SUCCEEDED payment for session B…
    const b = await makePendingBooking("wh-surplus", "cs_surplus_B");
    await processStripeEvent(paidEvent("evt_surplus_B", "cs_surplus_B", b.id));
    // …then a DIFFERENT session pays for the same booking → a surplus capture.
    // The authoritative succeeded-upsert of session A must NOT collide with the
    // succeeded row for session B (the one-PENDING index makes this safe; a
    // pending|succeeded index would 23505 here and 500 the webhook forever).
    const res = await processStripeEvent(paidEvent("evt_surplus_A", "cs_surplus_A", b.id, { payment_intent: null }));
    expect(res.bookingConfirmed).toBe(false);
    const [payA] = await db.select().from(payments).where(eq(payments.stripeCheckoutSessionId, "cs_surplus_A"));
    expect(payA!.status).toBe("succeeded");
    const [after] = await db.select().from(bookings).where(eq(bookings.id, b.id));
    expect(after!.status).toBe("confirmed");
  });

  it("creates an authoritative succeeded payment row even if none existed (lost checkout insert)", async () => {
    const b = await makeBookingNoPayment("wh-auth");
    const res = await processStripeEvent(paidEvent("evt_auth", "cs_auth", b.id));
    expect(res.bookingConfirmed).toBe(true);
    const [pay] = await db.select().from(payments).where(eq(payments.stripeCheckoutSessionId, "cs_auth"));
    expect(pay!.status).toBe("succeeded");
    expect(pay!.bookingId).toBe(b.id);
  });

  it("confirms on a delayed-settlement async_payment_succeeded event", async () => {
    const b = await makeBookingNoPayment("wh-async");
    const res = await processStripeEvent(
      paidEvent("evt_async", "cs_async", b.id, { payment_status: "unpaid" }, "checkout.session.async_payment_succeeded"),
    );
    expect(res.bookingConfirmed).toBe(true);
    const [after] = await db.select().from(bookings).where(eq(bookings.id, b.id));
    expect(after!.status).toBe("confirmed");
  });

  it("marks the payment failed on async_payment_failed without confirming", async () => {
    const b = await makePendingBooking("wh-failed", "cs_failed");
    const res = await processStripeEvent(
      paidEvent("evt_failed", "cs_failed", b.id, {}, "checkout.session.async_payment_failed"),
    );
    expect(res.bookingConfirmed).toBeFalsy();
    const [pay] = await db.select().from(payments).where(eq(payments.stripeCheckoutSessionId, "cs_failed"));
    expect(pay!.status).toBe("failed");
    const [after] = await db.select().from(bookings).where(eq(bookings.id, b.id));
    expect(after!.status).toBe("pending");
  });

  it("verifies a real Stripe signature and rejects a tampered body", () => {
    const stripe = getStripe();
    const payload = JSON.stringify({ id: "evt_sig", type: "checkout.session.completed", data: { object: {} } });
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret: env.STRIPE_WEBHOOK_SECRET });
    expect(() => stripe.webhooks.constructEvent(payload, header, env.STRIPE_WEBHOOK_SECRET)).not.toThrow();
    expect(() => stripe.webhooks.constructEvent(payload + "x", header, env.STRIPE_WEBHOOK_SECRET)).toThrow();
  });
});

describe("wave 02 payment tracking", () => {
  it("credits amountPaidCents when a booking is confirmed", async () => {
    const b = await makePendingBooking("wh-amt-1", "cs_amt_1");
    await processStripeEvent(paidEvent("evt_amt_1", "cs_amt_1", b.id));
    const [after] = await db.select().from(bookings).where(eq(bookings.id, b.id));
    expect(after!.status).toBe("confirmed");
    expect(after!.amountPaidCents).toBe(3000);
  });

  it("verifies against the recorded payment row, not recomputed snapshot math", async () => {
    const b = await makePendingBooking("wh-row-1", "cs_row_1");
    // Poison the snapshot so a recompute would demand a different amount; the
    // recorded pending row (3000) must win.
    await db.update(bookings)
      .set({ priceBreakdown: { ...breakdown, subtotalCents: 999999, depositPercent: 50, depositMinCents: 50000 } })
      .where(eq(bookings.id, b.id));
    const res = await processStripeEvent(paidEvent("evt_row_1", "cs_row_1", b.id));
    expect(res.bookingConfirmed).toBe(true);
  });

  it("extension payment confirms the payment and credits the booking without touching status", async () => {
    const b = await makePendingBooking("wh-ext-1", "cs_ext_seed_1");
    await processStripeEvent(paidEvent("evt_ext_seed_1", "cs_ext_seed_1", b.id)); // now confirmed, paid 3000
    await db.insert(payments).values({
      bookingId: b.id, stripeCheckoutSessionId: "cs_ext_1", type: "extension", method: "stripe",
      amountCents: 5800, currency: "USD", status: "pending",
    });
    const res = await processStripeEvent(paidEvent("evt_ext_1", "cs_ext_1", b.id, {
      amount_total: 5800, metadata: { bookingId: b.id, paymentType: "extension" },
    }));
    expect(res.bookingConfirmed).toBe(false);
    const [after] = await db.select().from(bookings).where(eq(bookings.id, b.id));
    expect(after!.status).toBe("confirmed");
    expect(after!.amountPaidCents).toBe(3000 + 5800);
    const [pay] = await db.select().from(payments).where(eq(payments.stripeCheckoutSessionId, "cs_ext_1"));
    expect(pay!.status).toBe("succeeded");
  });

  it("charge.refunded reconciles refund totals and decrements amountPaidCents", async () => {
    const b = await makePendingBooking("wh-ref-1", "cs_ref_1");
    await processStripeEvent(paidEvent("evt_ref_seed_1", "cs_ref_1", b.id)); // paid 3000, pi_cs_ref_1
    const refundEvent = {
      id: "evt_ref_1", type: "charge.refunded", object: "event", api_version: null,
      created: 0, livemode: false, pending_webhooks: 0, request: null,
      data: { object: { id: "ch_ref_1", object: "charge", payment_intent: "pi_cs_ref_1", amount_refunded: 3000 } },
    } as unknown as Stripe.Event;
    await processStripeEvent(refundEvent);
    const [pay] = await db.select().from(payments).where(eq(payments.stripeCheckoutSessionId, "cs_ref_1"));
    expect(pay!.status).toBe("refunded");
    expect(pay!.refundedCents).toBe(3000);
    const [after] = await db.select().from(bookings).where(eq(bookings.id, b.id));
    expect(after!.amountPaidCents).toBe(0);
    // Redelivery of the same totals is a no-op (delta 0).
    const again = { ...refundEvent, id: "evt_ref_2" } as unknown as Stripe.Event;
    await processStripeEvent(again);
    const [after2] = await db.select().from(bookings).where(eq(bookings.id, b.id));
    expect(after2!.amountPaidCents).toBe(0);
  });

  it("charge.refunded on an auto-refunded surplus PI does NOT zero a real credited deposit", async () => {
    // The booking is confirmed with a REAL credited deposit via its own session.
    const b = await makePendingBooking("wh-surplus-ref", "cs_surplus_ref_B");
    await processStripeEvent(paidEvent("evt_surplus_ref_B", "cs_surplus_ref_B", b.id));
    const [afterConfirm] = await db.select().from(bookings).where(eq(bookings.id, b.id));
    expect(afterConfirm!.amountPaidCents).toBe(3000); // genuine deposit on the books

    // A DIFFERENT session then pays the same (already confirmed) booking: a
    // surplus capture with a REAL payment_intent, which is auto-refunded. Its
    // money is NOT credited to amountPaidCents.
    const surplus = await processStripeEvent(
      paidEvent("evt_surplus_ref_A", "cs_surplus_ref_A", b.id, { payment_intent: "pi_surplus_ref_A" }),
    );
    expect(surplus.bookingConfirmed).toBe(false);
    expect(stripeRefundCreate).toHaveBeenCalledWith({ payment_intent: "pi_surplus_ref_A" });
    // The surplus row is pre-marked refunded in the same transaction so the
    // incoming charge.refunded nets to a delta of 0.
    const [payA] = await db.select().from(payments).where(eq(payments.stripeCheckoutSessionId, "cs_surplus_ref_A"));
    expect(payA!.refundedCents).toBe(3000);
    expect(payA!.status).toBe("refunded");
    const [afterSurplus] = await db.select().from(bookings).where(eq(bookings.id, b.id));
    expect(afterSurplus!.amountPaidCents).toBe(3000); // surplus not credited; deposit intact

    // Stripe's charge.refunded for the surplus PI arrives.
    const refundEvent = {
      id: "evt_surplus_ref_charge", type: "charge.refunded", object: "event", api_version: null,
      created: 0, livemode: false, pending_webhooks: 0, request: null,
      data: { object: { id: "ch_surplus_ref", object: "charge", payment_intent: "pi_surplus_ref_A", amount_refunded: 3000 } },
    } as unknown as Stripe.Event;
    await processStripeEvent(refundEvent);

    // The genuine deposit MUST survive: the bug debited it by the full surplus
    // and GREATEST(0, 3000 - 3000) silently zeroed a real paid balance.
    const [afterRefund] = await db.select().from(bookings).where(eq(bookings.id, b.id));
    expect(afterRefund!.amountPaidCents).toBe(3000);
  });
});
