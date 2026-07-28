/**
 * Inbound Stripe webhook reducer (signature already verified by the route via
 * stripe.webhooks.constructEvent).
 *
 * Money-safety properties:
 *   - ATOMIC: the event-id dedupe claim and every write commit in ONE
 *     transaction; a failure rolls the claim back so Stripe's retry redoes the
 *     work for real.
 *   - AUTHORITATIVE payment record: the payment row is UPSERTED by session id.
 *   - Amount/currency verified BEFORE any confirmation. The recorded payment
 *     row for the session is the primary expectation (it was written when the
 *     session was created, so it survives settings changes and legacy
 *     snapshots); recomputing from the snapshot is the fallback for a lost
 *     checkout-time insert.
 *   - Confirms ONLY a still-pending booking; surplus captures are recorded,
 *     flagged, and auto-refunded.
 *   - bookings.amount_paid_cents is credited on confirmation and on extension
 *     payments, and debited by charge.refunded reconciliation.
 *   - Extension payments (metadata paymentType=extension) confirm the PAYMENT
 *     only; the booking dates were already extended when the link was created.
 */
import type Stripe from "stripe";
import { eq, and, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { bookings, payments, stripeWebhookEvents } from "@/lib/db/schema";
import { chargeForBooking, type PaymentOption } from "@/lib/payments/charge";
import type { QuoteBreakdown } from "@/lib/booking/quote";
import { getStripe } from "@/lib/payments/stripe-client";
import { notifyAdmin } from "@/lib/notify";
import { logger } from "@/lib/logger";

export interface ProcessResult {
  handled: boolean;
  duplicate?: boolean;
  bookingConfirmed?: boolean;
  bookingId?: string;
}

const CONFIRM_EVENTS = new Set(["checkout.session.completed", "checkout.session.async_payment_succeeded"]);

export async function processStripeEvent(event: Stripe.Event): Promise<ProcessResult> {
  // async_payment_failed AND expired both mean "this session will never pay".
  if (event.type === "checkout.session.async_payment_failed" || event.type === "checkout.session.expired") {
    return markSessionFailed(event);
  }
  if (event.type === "charge.refunded") {
    return reconcileRefund(event);
  }
  if (!CONFIRM_EVENTS.has(event.type)) {
    return { handled: true }; // acked + ignored (no side effect, safe to reprocess)
  }

  const session = event.data.object as Stripe.Checkout.Session;
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
  let surplusRefund: { paymentIntentId: string; sessionId: string } | null = null;
  let extensionPaid = false;

  await db.transaction(async (tx) => {
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

    // Row-first amount verification (see module doc).
    const [known] = await tx.select().from(payments).where(eq(payments.stripeCheckoutSessionId, session.id));
    const expected = known
      ? { type: known.type, amountCents: known.amountCents, currency: known.currency }
      : chargeForBooking(booking.paymentOption as PaymentOption, booking.priceBreakdown as QuoteBreakdown);

    const paidAmount = session.amount_total ?? 0;
    const paidCurrency = (session.currency ?? "").toUpperCase();
    if (paidAmount !== expected.amountCents || paidCurrency !== expected.currency.toUpperCase()) {
      logger.error("stripe_webhook_amount_mismatch", { bookingId, paidAmount, expected: expected.amountCents, paidCurrency, eventId: event.id });
      return; // do NOT confirm on a mismatch
    }

    if (session.metadata?.paymentType === "extension" || known?.type === "extension") {
      await tx.insert(payments).values({
        bookingId: booking.id, stripeCheckoutSessionId: session.id, stripePaymentIntentId: paymentIntentId,
        type: "extension", method: "stripe", amountCents: expected.amountCents, currency: expected.currency, status: "succeeded",
      }).onConflictDoUpdate({
        target: payments.stripeCheckoutSessionId,
        set: { status: "succeeded", stripePaymentIntentId: paymentIntentId, updatedAt: new Date() },
      });
      await tx.update(bookings)
        .set({ amountPaidCents: sql`${bookings.amountPaidCents} + ${expected.amountCents}`, updatedAt: new Date() })
        .where(eq(bookings.id, booking.id));
      extensionPaid = true;
      result = { handled: true, bookingConfirmed: false, bookingId: booking.id };
      return;
    }

    // Upsert the payment row by session id -> succeeded (authoritative record).
    await tx.insert(payments).values({
      bookingId: booking.id,
      stripeCheckoutSessionId: session.id,
      stripePaymentIntentId: paymentIntentId,
      type: expected.type,
      method: "stripe",
      amountCents: expected.amountCents,
      currency: expected.currency,
      status: "succeeded",
    }).onConflictDoUpdate({
      target: payments.stripeCheckoutSessionId,
      set: { status: "succeeded", stripePaymentIntentId: paymentIntentId, updatedAt: new Date() },
    });

    // Flip pending -> confirmed (guarded) and credit the paid amount.
    const flipped = await tx.update(bookings)
      .set({
        status: "confirmed",
        amountPaidCents: sql`${bookings.amountPaidCents} + ${expected.amountCents}`,
        updatedAt: new Date(),
      })
      .where(and(eq(bookings.id, booking.id), eq(bookings.status, "pending")))
      .returning({ id: bookings.id });

    if (flipped.length > 0) {
      result = { handled: true, bookingConfirmed: true, bookingId: booking.id };
    } else {
      // Money captured but the booking was not pending: a real surplus charge.
      // Never resurrect a cancelled booking; flag + queue an automatic refund
      // once the transaction commits. Surplus money is NOT credited to
      // amount_paid_cents (it is on its way back to the card).
      logger.error("stripe_webhook_surplus_payment_needs_refund", {
        bookingId: booking.id, bookingStatus: booking.status, paymentIntentId, sessionId: session.id, eventId: event.id,
      });
      if (paymentIntentId) {
        // Pre-write the refund on THIS surplus row (mirrors refundPayment) in
        // the same transaction, BEFORE the PI is auto-refunded after commit.
        // The surplus was never credited to amount_paid_cents, so when the
        // resulting charge.refunded arrives, reconcileRefund sees
        // delta = amount_refunded - refundedCents = 0 and leaves the booking's
        // real paid balance untouched. This commits before the refund even
        // exists, so it is correct even if charge.refunded races ahead.
        await tx.update(payments)
          .set({ refundedCents: expected.amountCents, status: "refunded", updatedAt: new Date() })
          .where(eq(payments.stripeCheckoutSessionId, session.id));
        surplusRefund = { paymentIntentId, sessionId: session.id };
      }
      result = { handled: true, bookingConfirmed: false };
    }
  });

  if (extensionPaid) {
    await notifyAdmin({
      level: "success", type: "payment.received", title: "Extension payment received",
      body: "The customer paid the extension link.", bookingId,
    });
  }

  if (surplusRefund) {
    const { paymentIntentId: pi, sessionId } = surplusRefund;
    try {
      await getStripe().refunds.create({ payment_intent: pi });
      logger.warn("stripe_webhook_surplus_refunded", { paymentIntentId: pi, sessionId, eventId: event.id });
    } catch (e) {
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

/** charge.refunded: reconcile refund totals idempotently. refundPayment()
 *  records refunds it makes itself, so the delta here is usually 0; a refund
 *  made in the Stripe dashboard is picked up by this path. */
async function reconcileRefund(event: Stripe.Event): Promise<ProcessResult> {
  const charge = event.data.object as Stripe.Charge;
  const paymentIntentId = typeof charge.payment_intent === "string"
    ? charge.payment_intent
    : charge.payment_intent?.id ?? null;
  if (!paymentIntentId) return { handled: true };
  const db = await getDb();
  await db.transaction(async (tx) => {
    const claimed = await tx.insert(stripeWebhookEvents)
      .values({ eventId: event.id, type: event.type })
      .onConflictDoNothing({ target: stripeWebhookEvents.eventId })
      .returning({ eventId: stripeWebhookEvents.eventId });
    if (claimed.length === 0) return;
    const [payment] = await tx.select().from(payments).where(eq(payments.stripePaymentIntentId, paymentIntentId));
    if (!payment) return;
    const refundedTotal = charge.amount_refunded ?? 0;
    const delta = refundedTotal - payment.refundedCents;
    if (delta <= 0) return; // already recorded (e.g. by refundPayment)
    await tx.update(payments).set({
      refundedCents: refundedTotal,
      status: refundedTotal >= payment.amountCents ? "refunded" : payment.status,
      updatedAt: new Date(),
    }).where(eq(payments.id, payment.id));
    await tx.update(bookings)
      .set({ amountPaidCents: sql`GREATEST(0, ${bookings.amountPaidCents} - ${delta})`, updatedAt: new Date() })
      .where(eq(bookings.id, payment.bookingId));
  });
  return { handled: true };
}
