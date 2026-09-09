/**
 * Owner price override on an existing booking (design 2026-09-08 §3).
 *
 * The desk sometimes settles a rental against something else, or has to correct
 * a price after the fact. Whatever the owner types becomes the revenue: the
 * reports read priceBreakdown.subtotalCents and follow automatically.
 *
 * Owner-only, mirroring the money gate on extend-booking.ts:69-71 — a desk
 * price change moves real money in the books, and the audit row (with the
 * mandatory reason) is what replaces a second pair of eyes.
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { bookings, payments } from "@/lib/db/schema";
import { Errors } from "@/lib/http/errors";
import { applyPriceOverride, type OverridableBreakdown } from "@/lib/booking/price-override";
import { money, type BookingRow } from "@/lib/admin/inspections";
import type { AdminRole } from "@/lib/auth/admin-auth";

export interface SetPriceInput {
  subtotalCents: number;
  reason: string;
  adminId: string;
  role: AdminRole;
}

export interface SetPriceResult {
  booking: BookingRow;
  /** The subtotal immediately before THIS edit — what the audit row records. */
  previousSubtotalCents: number;
  newSubtotalCents: number;
}

export async function setBookingPrice(
  bookingId: string,
  input: SetPriceInput,
): Promise<SetPriceResult> {
  if (input.role !== "owner") {
    throw Errors.forbidden("Only an owner can change the price of a booking");
  }
  if (!Number.isInteger(input.subtotalCents)) {
    throw Errors.badRequest("Price must be a whole number of cents");
  }
  if (input.subtotalCents < 0) {
    throw Errors.badRequest("Price cannot be negative");
  }
  const reason = input.reason.trim();
  if (reason.length < 3) {
    throw Errors.badRequest("Please give a short reason for the price change");
  }
  if (reason.length > 500) {
    throw Errors.badRequest("Please keep the reason under 500 characters");
  }

  const db = await getDb();
  return db.transaction(async (tx) => {
    const [booking] = await tx.select().from(bookings).where(eq(bookings.id, bookingId)).for("update");
    if (!booking) throw Errors.notFound("Booking not found");
    if (booking.status === "cancelled") {
      throw Errors.conflict("This booking is cancelled, its price can no longer change");
    }
    if (input.subtotalCents < booking.amountPaidCents) {
      // Honest, not misdirecting: refundPayment() throws for any payment with
      // no Stripe intent, which is every desk payment, and both live clients
      // run desk mode. The owner has chosen not to build a desk-refund
      // capability, so the fix is to set the price before recording payment,
      // not to point at a refund path that's actually a locked door.
      const currency = String((booking.priceBreakdown as OverridableBreakdown).currency ?? "USD");
      throw Errors.badRequest(
        `Set the price before recording the payment; ${money(booking.amountPaidCents, currency)} is already paid on this booking.`,
      );
    }

    // An open checkout session was priced from this snapshot and the webhook
    // re-checks the expected amount against it when the money lands. Editing in
    // between silently desyncs Stripe from the booking.
    const [open] = await tx.select({ id: payments.id }).from(payments)
      .where(and(eq(payments.bookingId, bookingId), eq(payments.status, "pending")));
    if (open) {
      throw Errors.conflict("A payment is still open on this booking. Wait for it to settle or fail first.");
    }

    const previous = booking.priceBreakdown as OverridableBreakdown;
    const previousSubtotalCents = Number(previous.subtotalCents ?? 0);
    const next = applyPriceOverride(previous, input.subtotalCents, {
      reason,
      byAdminId: input.adminId,
      at: new Date().toISOString(),
    });

    const [updated] = await tx.update(bookings)
      .set({ priceBreakdown: next, updatedAt: new Date() })
      .where(eq(bookings.id, bookingId))
      .returning();

    return { booking: updated!, previousSubtotalCents, newSubtotalCents: input.subtotalCents };
  });
}
