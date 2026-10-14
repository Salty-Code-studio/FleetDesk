/**
 * Selects the bookings that could matter today and hands them to buildToday.
 * Candidates: anything starting or ending inside the Aruba day, anything
 * picked up and past its return, and anything out or just back in the last
 * 30 days (the unpaid pool). buildToday does the classifying.
 */
import { and, eq, gt, gte, lt, inArray, or } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { bookings, customers, vehicles } from "@/lib/db/schema";
import { atAruba, addHoursIso, arubaDateOf } from "@/lib/time/format";
import { paidState } from "@/lib/admin/paid-state";
import { buildToday, type TodayBoard, type TodayBookingInput } from "@/lib/admin/today";

export async function getToday(day: string, nowIso: string): Promise<TodayBoard> {
  const db = await getDb();
  const dayStart = atAruba(day, "00:00");
  const dayEnd = addHoursIso(dayStart, 24);
  const poolStart = addHoursIso(dayStart, -30 * 24);

  const rows = await db.select({
    id: bookings.id, startAt: bookings.startAt, endAt: bookings.endAt, status: bookings.status,
    amountPaidCents: bookings.amountPaidCents, priceBreakdown: bookings.priceBreakdown, paidUntil: bookings.paidUntil,
    customerName: customers.name, customerEmail: customers.email,
    plate: vehicles.plate, vehicleName: vehicles.name,
  }).from(bookings)
    .innerJoin(customers, eq(bookings.customerId, customers.id))
    .innerJoin(vehicles, eq(bookings.vehicleId, vehicles.id))
    .where(and(
      inArray(bookings.status, ["pending", "confirmed", "picked_up", "completed"]),
      or(
        and(gte(bookings.startAt, dayStart), lt(bookings.startAt, dayEnd)),
        and(gte(bookings.endAt, dayStart), lt(bookings.endAt, dayEnd)),
        and(eq(bookings.status, "picked_up"), lt(bookings.endAt, nowIso)),
        and(inArray(bookings.status, ["picked_up", "completed"]), gt(bookings.endAt, poolStart)),
      ),
    ));

  const todayLocal = arubaDateOf(nowIso);
  const input: TodayBookingInput[] = rows.map((r) => {
    const bd = (r.priceBreakdown ?? {}) as { subtotalCents?: number; currency?: string };
    const paid = paidState({
      status: r.status, paidUntil: r.paidUntil,
      subtotalCents: Number(bd.subtotalCents ?? 0), amountPaidCents: r.amountPaidCents,
      currency: bd.currency ?? "USD", todayLocal,
    });
    return {
      id: r.id, startAt: r.startAt, endAt: r.endAt, status: r.status,
      customerName: r.customerName, customerEmail: r.customerEmail,
      plate: r.plate, vehicleName: r.vehicleName,
      unpaid: paid.unpaid, balanceDueCents: paid.balanceDueCents, paidNote: paid.note,
    };
  });

  return buildToday(input, day, nowIso);
}
