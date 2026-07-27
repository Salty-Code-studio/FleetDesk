/**
 * Single-booking detail for the admin BookingDrawer: the booking itself,
 * its customer + vehicle, every payment row, and the two numbers the desk
 * needs at a glance — how much is settled and what is still owed at pickup.
 *
 * balanceDueCents is the ACTUAL remaining balance (subtotal minus whatever is
 * really settled on the booking, amountPaidCents — which the Stripe webhook
 * and desk payments credit and refunds debit), not the theoretical deposit/full
 * split from paymentAmounts(). It reflects reality even after a partial refund
 * or an extension payment.
 */
import { eq, asc } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { bookings, customers, vehicles, payments } from "@/lib/db/schema";
import { getSettings } from "@/lib/admin/settings";
import { isFreeCancellation } from "@/lib/booking/cancellation";
import { arubaNowIso } from "@/lib/time/format";
import type { QuoteBreakdown } from "@/lib/booking/quote";

export interface BookingDetailPayment {
  id: string;
  type: string;
  method: string;
  amountCents: number;
  refundedCents: number;
  status: string;
  createdAt: string;
  stripePaymentIntentId: string | null;
}

export interface BookingDetail {
  booking: {
    id: string;
    status: string;
    source: string;
    startAt: string;
    endAt: string;
    paymentOption: string;
    notes: string | null;
    priceBreakdown: QuoteBreakdown;
    amountPaidCents: number;
  };
  customer: { name: string; email: string; phone: string };
  vehicle: { id: string; name: string; plate: string };
  payments: BookingDetailPayment[];
  balanceDueCents: number;
  policySaysFree: boolean;
}

export async function getBookingDetail(id: string): Promise<BookingDetail | undefined> {
  const db = await getDb();

  const [row] = await db.select({
    id: bookings.id, status: bookings.status, source: bookings.source,
    startAt: bookings.startAt, endAt: bookings.endAt, paymentOption: bookings.paymentOption,
    notes: bookings.notes, priceBreakdown: bookings.priceBreakdown, amountPaidCents: bookings.amountPaidCents,
    customerName: customers.name, customerEmail: customers.email, customerPhone: customers.phone,
    vehicleId: vehicles.id, vehicleName: vehicles.name, vehiclePlate: vehicles.plate,
  }).from(bookings)
    .innerJoin(customers, eq(bookings.customerId, customers.id))
    .innerJoin(vehicles, eq(bookings.vehicleId, vehicles.id))
    .where(eq(bookings.id, id));
  if (!row) return undefined;

  const paymentRows = await db.select().from(payments)
    .where(eq(payments.bookingId, id))
    .orderBy(asc(payments.createdAt));

  const settings = await getSettings();
  const policySaysFree = isFreeCancellation({ startAt: row.startAt }, settings, arubaNowIso());

  const breakdown = row.priceBreakdown as QuoteBreakdown;
  const balanceDueCents = Math.max(0, breakdown.subtotalCents - row.amountPaidCents);

  return {
    booking: {
      id: row.id, status: row.status, source: row.source, startAt: row.startAt, endAt: row.endAt,
      paymentOption: row.paymentOption, notes: row.notes, priceBreakdown: breakdown,
      amountPaidCents: row.amountPaidCents,
    },
    customer: { name: row.customerName, email: row.customerEmail, phone: row.customerPhone },
    vehicle: { id: row.vehicleId, name: row.vehicleName, plate: row.vehiclePlate },
    payments: paymentRows.map((p) => ({
      id: p.id, type: p.type, method: p.method, amountCents: p.amountCents, refundedCents: p.refundedCents,
      status: p.status, createdAt: p.createdAt.toISOString(), stripePaymentIntentId: p.stripePaymentIntentId,
    })),
    balanceDueCents,
    policySaysFree,
  };
}
