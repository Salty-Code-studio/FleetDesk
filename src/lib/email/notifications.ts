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
  bookingConfirmedEmail, adminNewBookingEmail, adminPaymentEmail,
} from "@/lib/email/templates";
import { notifyAdmin, sendOwnerWhatsApp } from "@/lib/notify";
import { logger } from "@/lib/logger";
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
        vehicleName: ctx.vehicleName, startDate: ctx.booking.startDate, endDate: ctx.booking.endDate,
        customerEmail: ctx.customerEmail, paymentOption: ctx.booking.paymentOption,
      }),
    }));
    await notifyAdmin({
      level: "info", type: "booking.created", title: "New booking",
      body: `${ctx.vehicleName} · ${ctx.booking.startDate} → ${ctx.booking.endDate} · ${ctx.customerEmail}`,
      bookingId,
    });
    await sendOwnerWhatsApp(`New booking: ${ctx.vehicleName}, ${ctx.booking.startDate} → ${ctx.booking.endDate} (${ctx.customerEmail})`).catch(() => undefined);
  } catch (e) {
    logger.error("notify_new_booking_failed", { bookingId, error: (e as Error).message });
  }
}

/** Customer confirmation + admin payment alert after a paid webhook. */
export async function notifyBookingConfirmed(bookingId: string): Promise<void> {
  try {
    const ctx = await context(bookingId);
    if (!ctx) return;
    const settings = await getSettings();
    const breakdown = ctx.booking.priceBreakdown as QuoteBreakdown;
    const db = await getDb();
    const [pay] = await db.select().from(payments)
      .where(and(eq(payments.bookingId, bookingId), eq(payments.status, "succeeded")));

    await sendAndLog({
      to: ctx.customerEmail, type: "booking_confirmed",
      ...bookingConfirmedEmail({
        vehicleName: ctx.vehicleName, startDate: ctx.booking.startDate, endDate: ctx.booking.endDate,
        rentalTotalCents: breakdown.subtotalCents, currency: pay?.currency ?? breakdown.currency,
        amountPaidCents: pay?.amountCents, chargeType: pay?.type,
      }),
    });

    if (pay) {
      await sendToMany(settings.adminAlertRecipients, (to) => ({
        to, type: "admin_payment",
        ...adminPaymentEmail({
          vehicleName: ctx.vehicleName, amountCents: pay.amountCents, currency: pay.currency,
          customerEmail: ctx.customerEmail,
        }),
      }));
    }
    await notifyAdmin({
      level: "success", type: "payment.received", title: "Payment received",
      body: `${ctx.vehicleName} confirmed · ${ctx.customerEmail}`,
      bookingId,
    });
    await sendOwnerWhatsApp(`Payment received: ${ctx.vehicleName} confirmed (${ctx.customerEmail})`).catch(() => undefined);
  } catch (e) {
    logger.error("notify_booking_confirmed_failed", { bookingId, error: (e as Error).message });
  }
}
