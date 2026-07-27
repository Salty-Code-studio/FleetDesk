/**
 * A customer's own bookings (spec §4: view + manage). Everything is scoped to
 * the customer id from their session; a booking that isn't theirs is reported
 * as not-found (no enumeration / IDOR).
 */
import { and, eq, desc } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { bookings, vehicles, payments } from "@/lib/db/schema";
import { getSettings } from "@/lib/admin/settings";
import { isFreeCancellation } from "@/lib/booking/cancellation";
import { refundPayment } from "@/lib/payments/refunds";
import { Errors } from "@/lib/http/errors";
import { logger } from "@/lib/logger";
import type { QuoteBreakdown } from "@/lib/booking/quote";

export interface CustomerBookingView {
  id: string;
  vehicleName: string;
  startAt: string;
  endAt: string;
  status: string;
  paymentOption: string;
  breakdown: QuoteBreakdown;
}

export async function listCustomerBookings(customerId: string): Promise<CustomerBookingView[]> {
  const db = await getDb();
  const rows = await db.select({
    id: bookings.id, startAt: bookings.startAt, endAt: bookings.endAt,
    status: bookings.status, paymentOption: bookings.paymentOption, breakdown: bookings.priceBreakdown,
    vehicleName: vehicles.name,
  }).from(bookings)
    .innerJoin(vehicles, eq(bookings.vehicleId, vehicles.id))
    .where(eq(bookings.customerId, customerId))
    .orderBy(desc(bookings.createdAt));
  return rows.map((r) => ({ ...r, breakdown: r.breakdown as QuoteBreakdown }));
}

export interface CancelledBooking {
  id: string; vehicleName: string; startAt: string; endAt: string;
  refunded: boolean; refundCents: number; refundError: boolean;
}

/** Cancel the customer's own pending|confirmed booking. Frees the slot
 *  (cancelled is outside the exclusion constraint). Applies the cancellation
 *  window policy (spec §16): outside the window, succeeded payments are
 *  auto-refunded; inside it (and no-shows), the deposit is not refunded. A
 *  refund that errors never blocks the cancellation, it just gets logged
 *  loudly for an admin retry from the Drawer. */
export async function cancelOwnBooking(customerId: string, bookingId: string, nowIso: string): Promise<CancelledBooking> {
  const db = await getDb();
  const [booking] = await db.select().from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.customerId, customerId)));
  if (!booking) throw Errors.notFound("Booking not found"); // also covers "not yours"
  if (booking.status !== "pending" && booking.status !== "confirmed") {
    throw Errors.conflict("This booking can no longer be cancelled");
  }
  const [vehicle] = await db.select({ name: vehicles.name }).from(vehicles).where(eq(vehicles.id, booking.vehicleId));
  await db.update(bookings).set({ status: "cancelled", updatedAt: new Date() }).where(eq(bookings.id, bookingId));

  let refundCents = 0;
  let refundError = false;
  const settings = await getSettings();
  if (isFreeCancellation(booking, settings, nowIso)) {
    const succeeded = await db.select().from(payments)
      .where(and(eq(payments.bookingId, bookingId), eq(payments.status, "succeeded")));
    for (const p of succeeded) {
      try {
        const before = p.refundedCents;
        const r = await refundPayment(p.id);
        refundCents += r.refundedCents - before;
      } catch (e) {
        refundError = true;
        logger.error("customer_cancel_refund_failed", { bookingId, paymentId: p.id, error: (e as Error).message });
      }
    }
  }

  return {
    id: booking.id, vehicleName: vehicle?.name ?? "your car", startAt: booking.startAt, endAt: booking.endAt,
    refunded: refundCents > 0, refundCents, refundError,
  };
}
