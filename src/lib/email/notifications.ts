/**
 * Transactional notifications (spec §9). Each fetches what it needs and fans
 * out best-effort emails (sendAndLog never throws). Called from the routes so
 * the booking/payment libs stay pure. Wrapped so a notification failure can
 * never break a booking or a payment confirmation.
 */
import { eq, and } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { bookings, vehicles, customers, payments } from "@/lib/db/schema";
import { getSettings } from "@/lib/admin/settings";
import { sendAndLog, sendToMany } from "@/lib/email/send";
import {
  bookingConfirmedEmail, bookingCancelledEmail, adminNewBookingEmail, adminPaymentEmail, bookingExtendedEmail,
} from "@/lib/email/templates";
import { notifyAdmin, sendOwnerWhatsApp } from "@/lib/notify";
import { logger } from "@/lib/logger";
import { formatDateTime } from "@/lib/time/format";
import type { QuoteBreakdown } from "@/lib/booking/quote";

async function context(bookingId: string) {
  const db = await getDb();
  const [row] = await db.select({
    booking: bookings, vehicleName: vehicles.name, customerEmail: customers.email,
  }).from(bookings)
    .innerJoin(vehicles, eq(bookings.vehicleId, vehicles.id))
    .innerJoin(customers, eq(bookings.customerId, customers.id))
    .where(eq(bookings.id, bookingId));
  return row;
}

/** Admin alert: a new booking was created. */
export async function notifyNewBooking(bookingId: string): Promise<void> {
  try {
    const ctx = await context(bookingId);
    if (!ctx) return;
    const settings = await getSettings();
    await sendToMany(settings.adminAlertRecipients, (to) => ({
      to, type: "admin_new_booking",
      ...adminNewBookingEmail({
        vehicleName: ctx.vehicleName, startAt: ctx.booking.startAt, endAt: ctx.booking.endAt,
        customerEmail: ctx.customerEmail, paymentOption: ctx.booking.paymentOption,
      }),
    }));
    await notifyAdmin({
      level: "info", type: "booking.created", title: "New booking",
      body: `${ctx.vehicleName} · ${formatDateTime(ctx.booking.startAt)} → ${formatDateTime(ctx.booking.endAt)} · ${ctx.customerEmail}`,
      bookingId,
    });
    await sendOwnerWhatsApp(`New booking: ${ctx.vehicleName}, ${formatDateTime(ctx.booking.startAt)} → ${formatDateTime(ctx.booking.endAt)} (${ctx.customerEmail})`).catch(() => undefined);
  } catch (e) {
    logger.error("notify_new_booking_failed", { bookingId, error: (e as Error).message });
  }
}

/** Customer confirmation + admin payment alert after a paid webhook (online)
 *  or a desk-mode approval decision (Telegram tap, email link, admin button,
 *  none of which ever take an online payment). `paid` is keyed on whether a
 *  succeeded payment row actually exists, never on PAYMENT_MODE, so the copy
 *  stays correct for both origins through this one shared funnel. */
export async function notifyBookingConfirmed(bookingId: string): Promise<void> {
  try {
    const ctx = await context(bookingId);
    if (!ctx) return;
    const settings = await getSettings();
    const breakdown = ctx.booking.priceBreakdown as QuoteBreakdown;
    const db = await getDb();
    const [pay] = await db.select().from(payments)
      .where(and(eq(payments.bookingId, bookingId), eq(payments.status, "succeeded")));
    const paid = Boolean(pay);

    await sendAndLog({
      to: ctx.customerEmail, type: "booking_confirmed",
      ...bookingConfirmedEmail({
        vehicleName: ctx.vehicleName, startAt: ctx.booking.startAt, endAt: ctx.booking.endAt,
        rentalTotalCents: breakdown.subtotalCents, currency: pay?.currency ?? breakdown.currency,
        amountPaidCents: pay?.amountCents, chargeType: pay?.type,
        paid,
      }),
    });

    if (pay) {
      await sendToMany(settings.adminAlertRecipients, (to) => ({
        to, type: "admin_payment",
        ...adminPaymentEmail({
          vehicleName: ctx.vehicleName, startAt: ctx.booking.startAt, endAt: ctx.booking.endAt,
          amountCents: pay.amountCents, currency: pay.currency,
          customerEmail: ctx.customerEmail,
        }),
      }));
    }
    await notifyAdmin({
      level: "success",
      type: paid ? "payment.received" : "booking.confirmed",
      title: paid ? "Payment received" : "Booking confirmed",
      body: paid
        ? `${ctx.vehicleName} confirmed · ${ctx.customerEmail}`
        : `${ctx.vehicleName} confirmed, pay at pickup · ${ctx.customerEmail}`,
      bookingId,
    });
    await sendOwnerWhatsApp(paid
      ? `Payment received: ${ctx.vehicleName} confirmed (${ctx.customerEmail})`
      : `Booking confirmed (pay at pickup): ${ctx.vehicleName} confirmed (${ctx.customerEmail})`,
    ).catch(() => undefined);
  } catch (e) {
    logger.error("notify_booking_confirmed_failed", { bookingId, error: (e as Error).message });
  }
}

/** Customer + admin cancellation notice, carrying the refund outcome (spec §16).
 *  Shared by both cancellation paths: the customer's own self-service cancel
 *  (window policy decides the refund) and the admin cancel (Task 7's explicit
 *  refund/no-refund choice) — both produce the same `{ refunded, refundCents,
 *  refundError }` shape, so this one template variant covers either origin.
 *  `policySaysFree` is admin-path-only: it lets the email tell "policy denied
 *  the refund" (customer cancelled late) apart from "admin overrode policy and
 *  denied a refund the window would otherwise have granted" (goodwill denial). */
export async function notifyBookingCancelled(
  bookingId: string,
  refund: { refunded: boolean; refundCents: number; refundError?: boolean; policySaysFree?: boolean },
): Promise<void> {
  try {
    const ctx = await context(bookingId);
    if (!ctx) return;
    const settings = await getSettings();
    const breakdown = ctx.booking.priceBreakdown as QuoteBreakdown;
    const db = await getDb();
    const [pay] = await db.select().from(payments)
      .where(and(eq(payments.bookingId, bookingId), eq(payments.status, "succeeded")));
    const emailArgs = {
      vehicleName: ctx.vehicleName, startAt: ctx.booking.startAt, endAt: ctx.booking.endAt,
      refund, cancellationWindowHours: settings.cancellationWindowHours, currency: pay?.currency ?? breakdown.currency,
    };

    await sendAndLog({ to: ctx.customerEmail, type: "booking_cancelled", ...bookingCancelledEmail(emailArgs) });
    await sendToMany(settings.adminAlertRecipients, (to) => ({
      to, type: "admin_booking_cancelled", ...bookingCancelledEmail(emailArgs),
    }));
    await notifyAdmin({
      level: refund.refundError ? "warning" : "info", type: "booking.cancelled", title: "Booking cancelled",
      body: `${ctx.vehicleName} · ${formatDateTime(ctx.booking.startAt)} → ${formatDateTime(ctx.booking.endAt)} · ${ctx.customerEmail}`,
      bookingId,
    });
  } catch (e) {
    logger.error("notify_booking_cancelled_failed", { bookingId, error: (e as Error).message });
  }
}

/** Customer + admin notice after a desk-side rental extension (Task 9). The
 *  dates are already extended; `checkoutUrl` (link path) tells the customer to
 *  pay the delta, its absence means the desk already settled it. Kept at the
 *  route so extendBooking stays a pure, testable lib (same split as cancel). */
export async function notifyBookingExtended(
  bookingId: string,
  info: { deltaCents: number; newEndAt: string; checkoutUrl: string | null },
): Promise<void> {
  try {
    const ctx = await context(bookingId);
    if (!ctx) return;
    const currency = (ctx.booking.priceBreakdown as QuoteBreakdown).currency;
    await sendAndLog({
      to: ctx.customerEmail, type: "booking_extended",
      ...bookingExtendedEmail({
        vehicleName: ctx.vehicleName, newEndAt: info.newEndAt,
        deltaCents: info.deltaCents, currency, checkoutUrl: info.checkoutUrl,
      }),
    });
    await notifyAdmin({
      level: "info", type: "booking.extended", title: "Booking extended",
      body: `${ctx.vehicleName} · now until ${formatDateTime(info.newEndAt)} · ${ctx.customerEmail}`,
      bookingId,
    });
  } catch (e) {
    logger.error("notify_booking_extended_failed", { bookingId, error: (e as Error).message });
  }
}
