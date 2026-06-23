/**
 * Inbound Stripe webhook reducer (signature already verified by the route via
 * stripe.webhooks.constructEvent).
 *
 * Money-safety properties:
 *   - ATOMIC: the event-id dedupe claim, the payment upsert, and the booking
 *     flip all commit in ONE transaction. If anything fails, the claim rolls
 *     back too, so Stripe's retry re-does the work for real (no "claimed but
 *     never confirmed" lost payments).
 *   - AUTHORITATIVE payment record: the payment row is UPSERTED by session id,
 *     so a confirmed booking always has a succeeded payment row even if the
 *     checkout-time insert was lost.
 *   - Amount/currency verified against the server-expected charge before any
 *     confirmation.
 *   - Confirms ONLY a still-pending booking; a surplus/orphan succeeded payment
 *     (already-confirmed or cancelled booking) is recorded and LOUDLY flagged
 *     for refund rather than silently swallowed.
 *   - Handles delayed-settlement methods: async_payment_succeeded confirms,
 *     async_payment_failed marks the payment failed.
 */
import type Stripe from "stripe";
import { eq, and } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { bookings, payments, stripeWebhookEvents } from "@/lib/db/schema";
import { chargeForBooking, type PaymentOption } from "@/lib/payments/charge";
import type { QuoteBreakdown } from "@/lib/booking/quote";
import { getStripe } from "@/lib/payments/stripe-client";
import { logger } from "@/lib/logger";

export interface ProcessResult {
  handled: boolean;
  duplicate?: boolean;
  bookingConfirmed?: boolean;
  bookingId?: string;
}

const CONFIRM_EVENTS = new Set(["checkout.session.completed", "checkout.session.async_payment_succeeded"]);

export async function processStripeEvent(event: Stripe.Event): Promise<ProcessResult> {
  // async_payment_failed AND expired both mean "this session will never pay":
  // mark its payment row failed so the booking is no longer protected from
  // hold-expiry. Without the expired case an abandoned checkout leaves a stuck
  // 'pending' payment that pins the car's dates forever (expireStaleHolds skips
  // any booking with a non-failed payment).
  if (event.type === "checkout.session.async_payment_failed" || event.type === "checkout.session.expired") {
    return markSessionFailed(event);
  }
  if (!CONFIRM_EVENTS.has(event.type)) {
    return { handled: true }; // acked + ignored (no side effect → safe to reprocess)
  }

  const session = event.data.object as Stripe.Checkout.Session;
  // async_payment_succeeded always means paid; completed must be payment_status paid.
  if (event.type === "checkout.session.completed" && session.payment_status !== "paid") {
    return { handled: true };
  }

  const bookingId = session.metadata?.bookingId;
  if (!bookingId) {
    logger.warn("stripe_webhook_no_booking", { sessionId: session.id, eventId: event.id });
    return { handled: true };
  }

  const paymentIntentId = typeof session.payment_intent === "string"
    ? session.payment_intent
    : session.payment_intent?.id ?? null;

  const db = await getDb();
  let result: ProcessResult = { handled: true };
  // A surplus capture (paid against a booking that is no longer pending) is
  // refunded AFTER the transaction commits — never do Stripe network I/O while
  // holding a DB transaction open.
  let surplusRefund: { paymentIntentId: string; sessionId: string } | null = null;

  await db.transaction(async (tx) => {
    // Dedupe gate INSIDE the transaction: if the id already exists, this event
    // was fully processed before — nothing to do.
    const claimed = await tx.insert(stripeWebhookEvents)
      .values({ eventId: event.id, type: event.type })
      .onConflictDoNothing({ target: stripeWebhookEvents.eventId })
      .returning({ eventId: stripeWebhookEvents.eventId });
    if (claimed.length === 0) { result = { handled: true, duplicate: true }; return; }

    const [booking] = await tx.select().from(bookings).where(eq(bookings.id, bookingId));
    if (!booking) {
      logger.warn("stripe_webhook_booking_missing", { bookingId, eventId: event.id });
      return; // claim commits; nothing to confirm
    }

    const expected = chargeForBooking(booking.paymentOption as PaymentOption, booking.priceBreakdown as QuoteBreakdown);
    const paidAmount = session.amount_total ?? 0;
    const paidCurrency = (session.currency ?? "").toUpperCase();
    if (paidAmount !== expected.amountCents || paidCurrency !== expected.currency.toUpperCase()) {
      logger.error("stripe_webhook_amount_mismatch", { bookingId, paidAmount, expected: expected.amountCents, paidCurrency, eventId: event.id });
      return; // do NOT confirm on a mismatch
    }

    // Upsert the payment row by session id → succeeded (authoritative record).
    await tx.insert(payments).values({
      bookingId: booking.id,
      stripeCheckoutSessionId: session.id,
      stripePaymentIntentId: paymentIntentId,
      type: expected.type,
      amountCents: expected.amountCents,
      currency: expected.currency,
      status: "succeeded",
    }).onConflictDoUpdate({
      target: payments.stripeCheckoutSessionId,
      set: { status: "succeeded", stripePaymentIntentId: paymentIntentId, updatedAt: new Date() },
    });

    // Flip pending → confirmed (guarded: only if still pending).
    const flipped = await tx.update(bookings)
      .set({ status: "confirmed", updatedAt: new Date() })
      .where(and(eq(bookings.id, booking.id), eq(bookings.status, "pending")))
      .returning({ id: bookings.id });

    if (flipped.length > 0) {
      result = { handled: true, bookingConfirmed: true, bookingId: booking.id };
    } else {
      // Money captured but the booking was not pending → a real surplus charge.
      // We deliberately do NOT auto-resurrect a cancelled booking here: the
      // webhook can't tell an auto-expired hold from a deliberate admin/customer
      // cancellation, so reviving could un-cancel an intentionally cancelled
      // booking. (The hold-expiry cron can no longer cancel a *payable* booking
      // anyway: checkout now writes the pending payment row in-transaction before
      // the customer can pay, and expireStaleHolds skips any non-failed payment.)
      // Flag the surplus AND queue an automatic refund once the transaction commits.
      logger.error("stripe_webhook_surplus_payment_needs_refund", {
        bookingId: booking.id, bookingStatus: booking.status, paymentIntentId, sessionId: session.id, eventId: event.id,
      });
      if (paymentIntentId) surplusRefund = { paymentIntentId, sessionId: session.id };
      result = { handled: true, bookingConfirmed: false };
    }
  });

  if (surplusRefund) {
    const { paymentIntentId: pi, sessionId } = surplusRefund;
    try {
      await getStripe().refunds.create({ payment_intent: pi });
      logger.warn("stripe_webhook_surplus_refunded", { paymentIntentId: pi, sessionId, eventId: event.id });
    } catch (e) {
      // Best-effort: if the refund call fails, the surplus stays flagged in the
      // logs above for manual handling. Never throw — the booking is already
      // correctly confirmed/cancelled and the event must still be acked.
      logger.error("stripe_webhook_surplus_refund_failed", { paymentIntentId: pi, sessionId, eventId: event.id, error: String(e) });
    }
  }

  return result;
}

async function markSessionFailed(event: Stripe.Event): Promise<ProcessResult> {
  const session = event.data.object as Stripe.Checkout.Session;
  const db = await getDb();
  await db.transaction(async (tx) => {
    const claimed = await tx.insert(stripeWebhookEvents)
      .values({ eventId: event.id, type: event.type })
      .onConflictDoNothing({ target: stripeWebhookEvents.eventId })
      .returning({ eventId: stripeWebhookEvents.eventId });
    if (claimed.length === 0) return;
    await tx.update(payments)
      .set({ status: "failed", updatedAt: new Date() })
      .where(eq(payments.stripeCheckoutSessionId, session.id));
  });
  return { handled: true };
}
