/**
 * Builds the internal approval ping from LIVE back-office data, so the manager
 * sees what the back office knows before tapping. The fleet line counts
 * same-class ACTIVE vehicles with no overlapping active booking over the
 * requested dates (same overlap rules as availability: [startAt, bufferEndAt)).
 * Plain text on purpose: it renders identically in Telegram and email.
 */
import { and, eq, gt, inArray, lt, ne } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { bookings, customers, vehicles } from "@/lib/db/schema";
import { formatDateTime } from "@/lib/time/format";
import { siteConfig } from "@/lib/site-config";
import type { QuoteBreakdown } from "@/lib/booking/quote";

export interface ApprovalMessage {
  text: string;
  vehicleName: string;
  startAt: string;
  endAt: string;
  customerName: string;
  totalLabel: string;
  fleetLine: string;
}

export async function buildApprovalMessage(bookingId: string): Promise<ApprovalMessage | null> {
  const db = await getDb();
  const [row] = await db.select({
    booking: bookings, vehicle: vehicles,
    customerName: customers.name, customerPhone: customers.phone, customerEmail: customers.email,
  }).from(bookings)
    .innerJoin(vehicles, eq(bookings.vehicleId, vehicles.id))
    .innerJoin(customers, eq(bookings.customerId, customers.id))
    .where(eq(bookings.id, bookingId));
  if (!row) return null;

  const b = row.booking;
  const breakdown = b.priceBreakdown as QuoteBreakdown;
  const totalLabel = formatMoney(breakdown.subtotalCents ?? 0, breakdown.currency ?? "USD");

  const classmates = await db.select({ id: vehicles.id }).from(vehicles)
    .where(and(eq(vehicles.class, row.vehicle.class), eq(vehicles.status, "active")));
  let free = 0;
  for (const v of classmates) {
    const [conflict] = await db.select({ id: bookings.id }).from(bookings)
      .where(and(
        eq(bookings.vehicleId, v.id),
        inArray(bookings.status, ["pending", "confirmed", "picked_up"]),
        lt(bookings.startAt, b.endAt),
        gt(bookings.bufferEndAt, b.startAt),
        ne(bookings.id, b.id),
      )).limit(1);
    if (!conflict) free += 1;
  }
  const fleetLine = `Fleet check: ${free} of ${classmates.length} ${row.vehicle.class} free on those dates`;

  const contact = row.customerPhone || row.customerEmail;
  const text = [
    `New booking · ${siteConfig.siteName}`,
    `${row.vehicle.name} (${row.vehicle.class})`,
    `${formatDateTime(b.startAt)} to ${formatDateTime(b.endAt)}`,
    `${totalLabel} · pay at pickup`,
    `${row.customerName} · ${contact}`,
    fleetLine,
  ].join("\n");

  return { text, vehicleName: row.vehicle.name, startAt: b.startAt, endAt: b.endAt, customerName: row.customerName, totalLabel, fleetLine };
}

function formatMoney(cents: number, currency: string): string {
  return `${currency} ${(cents / 100).toFixed(2)}`;
}
