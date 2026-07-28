import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { payments, bookings } from "@/lib/db/schema";
import { getStripe } from "@/lib/payments/stripe-client";
import { Errors } from "@/lib/http/errors";

/**
 * Admin-initiated refund. Applies the result locally right away (dev has no
 * webhooks); the charge.refunded webhook later reconciles refundedCents to
 * Stripe's absolute amount_refunded, which is idempotent with this write.
 */
export async function refundPayment(paymentId: string, opts: { amountCents?: number } = {}) {
  const db = await getDb();
  return await db.transaction(async (tx) => {
    const [p] = await tx.select().from(payments).where(eq(payments.id, paymentId)).for("update");
    if (!p) throw Errors.notFound("Payment not found");
    if (p.status !== "succeeded" && p.status !== "refunded") throw Errors.conflict("Only settled payments can be refunded");
    if (!p.stripePaymentIntentId) throw Errors.conflict("No Stripe payment behind this row");
    const remaining = p.amountCents - p.refundedCents;
    const amount = opts.amountCents ?? remaining;
    if (amount <= 0 || amount > remaining) throw Errors.badRequest(`Refund must be between 1 and ${remaining} cents`);

    await getStripe().refunds.create({ payment_intent: p.stripePaymentIntentId, amount });

    const refundedCents = p.refundedCents + amount;
    const status = refundedCents >= p.amountCents ? "refunded" : p.status;
    await tx.update(payments).set({ refundedCents, status }).where(eq(payments.id, p.id));
    const [b] = await tx.select().from(bookings).where(eq(bookings.id, p.bookingId)).for("update");
    if (b) await tx.update(bookings).set({ amountPaidCents: Math.max(0, b.amountPaidCents - amount) }).where(eq(bookings.id, b.id));
    // appliedCents is the delta THIS call actually wrote inside the locked
    // transaction (`amount`), not a difference against any pre-transaction
    // read. Callers must use it (not their own before/after snapshot) so a
    // concurrent refund on the same payment can never inflate what gets
    // reported or emailed.
    return { refundedCents, status, appliedCents: amount };
  });
}
