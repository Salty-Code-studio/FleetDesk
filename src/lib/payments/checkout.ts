/**
 * Create a Stripe Checkout Session for a pending booking. The amount is
 * recomputed server-side from the booking's snapshot; we record a pending
 * payment row and hand Stripe an inline price (no client-supplied money). The
 * hosted Checkout page handles all card data. Dynamic payment methods (no
 * payment_method_types) maximise conversion.
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { isUniqueViolation } from "@/lib/db/errors";
import { bookings, payments, vehicles } from "@/lib/db/schema";
import { Errors } from "@/lib/http/errors";
import { getStripe } from "@/lib/payments/stripe-client";
import { chargeForBooking, type PaymentOption, type ChargeType } from "@/lib/payments/charge";
import type { QuoteBreakdown } from "@/lib/booking/quote";
import { formatDateTime } from "@/lib/time/format";

const LABEL: Record<ChargeType, string> = {
  reservation_fee: "Reservation fee",
  deposit: "Security deposit",
  rental_deposit: "Deposit to reserve",
  rental_full: "Rental payment",
  extension: "Extension payment",
};

export async function createBookingCheckout(bookingId: string, origin: string): Promise<{ url: string }> {
  const db = await getDb();
  const stripe = getStripe();

  return await db.transaction(async (tx) => {
    // Lock the booking row so two concurrent checkout calls for it SERIALIZE.
    // The check → expire-prior → create-session → insert-row sequence is then
    // atomic per booking, so a second tab or a quick retry can't stand up a
    // second payable session and double-charge. The partial unique index on
    // payments(booking_id) for live statuses is the DB-level backstop.
    const [booking] = await tx.select().from(bookings).where(eq(bookings.id, bookingId)).for("update");
    if (!booking) throw Errors.notFound("Booking not found");
    if (booking.status !== "pending") throw Errors.conflict("This booking is no longer awaiting payment");

    // Front-line guard: never start a second checkout once a payment succeeded.
    const [paid] = await tx.select({ id: payments.id }).from(payments)
      .where(and(eq(payments.bookingId, booking.id), eq(payments.status, "succeeded")));
    if (paid) throw Errors.conflict("This booking is already paid");

    const breakdown = booking.priceBreakdown as QuoteBreakdown;
    const charge = chargeForBooking(booking.paymentOption as PaymentOption, breakdown);
    const [vehicle] = await tx.select({ name: vehicles.name }).from(vehicles).where(eq(vehicles.id, booking.vehicleId));

    // Expire every prior still-open session before opening a new one (reopen /
    // abandon-and-return). A session that can't be expired is already
    // completing/paid → refuse rather than risk a second charge. Mark each prior
    // pending row failed so it frees the one-live-payment unique index slot.
    const livePayments = await tx.select({ id: payments.id, sid: payments.stripeCheckoutSessionId })
      .from(payments)
      .where(and(eq(payments.bookingId, booking.id), eq(payments.status, "pending")));
    for (const p of livePayments) {
      if (p.sid) {
        try {
          await stripe.checkout.sessions.expire(p.sid);
        } catch {
          throw Errors.conflict("A payment for this booking is already in progress");
        }
      }
      await tx.update(payments).set({ status: "failed", updatedAt: new Date() }).where(eq(payments.id, p.id));
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      // Omit payment_method_types → dynamic payment methods (Stripe best practice).
      line_items: [{
        quantity: 1,
        price_data: {
          currency: charge.currency.toLowerCase(),
          unit_amount: charge.amountCents,
          product_data: {
            name: `${LABEL[charge.type]} — ${vehicle?.name ?? "FleetDesk rental"}`,
            description: `${formatDateTime(booking.startAt)} to ${formatDateTime(booking.endAt)}`,
          },
        },
      }],
      metadata: { bookingId: booking.id, paymentType: charge.type },
      success_url: `${origin}/book/confirmation?id=${booking.id}`,
      cancel_url: `${origin}/book?canceled=1&id=${booking.id}`,
    });

    if (!session.url) throw Errors.badRequest("Could not start checkout");

    // Record the pending payment row keyed to this session — in the SAME
    // transaction and before the URL is returned, so a checkout the customer can
    // actually pay always has a tracking row (which also protects the hold from
    // the expiry cron). The unique index makes a duplicate live row fail fast.
    try {
      await tx.insert(payments).values({
        bookingId: booking.id,
        stripeCheckoutSessionId: session.id,
        type: charge.type,
        method: "stripe",
        amountCents: charge.amountCents,
        currency: charge.currency,
        status: "pending",
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw Errors.conflict("A payment for this booking is already in progress");
      throw e;
    }

    return { url: session.url };
  });
}
