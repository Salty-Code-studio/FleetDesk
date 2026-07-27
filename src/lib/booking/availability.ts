/**
 * Date guardrails (spec §7) and availability checks. The HARD guarantee is the
 * Postgres exclusion constraint, which spans [start, bufferEnd) so it enforces
 * BOTH no-double-booking AND the turnaround (cleaning) buffer at insert time,
 * even under a race. This module is the pre-flight check that powers the UI and
 * gives clean errors before we attempt the insert.
 */
import { and, eq, ne, lt, gt, sql, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { vehicles, bookings, bookingAddOns, availabilityBlocks, blackoutDates } from "@/lib/db/schema";
import { rentalDays } from "@/lib/booking/quote";
import { addHoursIso, arubaDateOf, arubaTimeOf, parseTs } from "@/lib/time/format";
import { Errors } from "@/lib/http/errors";

export interface DateGuardSettings {
  minRentalDays: number;
  maxRentalDays: number;
  maxAdvanceDays: number;
  turnaroundBufferHours: number;
}

/** Throws a 400 if the timestamps break a guardrail. `nowIso` is a full timestamp. */
export function validateDates(startAt: string, endAt: string, settings: DateGuardSettings, nowIso: string): void {
  if (Number.isNaN(parseTs(startAt)) || Number.isNaN(parseTs(endAt))) {
    throw Errors.badRequest("Pick-up and return must be timestamps");
  }
  if (parseTs(endAt) <= parseTs(startAt)) throw Errors.badRequest("Return must be after pick-up");
  if (parseTs(startAt) < parseTs(nowIso)) throw Errors.badRequest("Pick-up cannot be in the past");
  const days = rentalDays(startAt, endAt);
  if (days < settings.minRentalDays) throw Errors.badRequest(`Minimum rental is ${settings.minRentalDays} day(s)`);
  if (days > settings.maxRentalDays) throw Errors.badRequest(`Maximum rental is ${settings.maxRentalDays} day(s)`);
  const advanceDays = Math.floor((parseTs(startAt) - parseTs(nowIso)) / 86_400_000);
  if (advanceDays > settings.maxAdvanceDays) throw Errors.badRequest(`Bookings open at most ${settings.maxAdvanceDays} day(s) ahead`);
}

export interface AvailabilityResult {
  available: boolean;
  reason?: string;
}

/**
 * Is `vehicleId` free for [start, end)? Checks the vehicle is active, has no
 * overlapping pending/confirmed booking (expanded by the turnaround buffer),
 * no availability block, and no blackout window touching the range.
 */
export async function checkAvailability(
  vehicleId: string,
  startAt: string,
  endAt: string,
  settings: { turnaroundBufferHours: number },
): Promise<AvailabilityResult> {
  const db = await getDb();

  const [vehicle] = await db.select().from(vehicles).where(eq(vehicles.id, vehicleId));
  if (!vehicle) return { available: false, reason: "Vehicle not found" };
  if (vehicle.status !== "active") return { available: false, reason: "Vehicle is not available" };

  // Mirror the DB exclusion rule EXACTLY: it overlaps tstzrange(start, bufferEnd)
  // using each row's OWN stored buffer_end_at (frozen at its creation). The new
  // booking will store bufferEnd = end + the CURRENT buffer hours. Two ranges
  // overlap iff existing.start < newBufferEnd AND existing.bufferEnd > newStart.
  // Comparing against each row's stored bufferEnd (not a freshly re-derived
  // buffer) means raising turnaroundBufferHours after older bookings exist no
  // longer over-rejects a slot the authoritative constraint would still accept.
  const newBufferEnd = addHoursIso(endAt, settings.turnaroundBufferHours);

  const clashing = await db.select({ id: bookings.id }).from(bookings).where(and(
    eq(bookings.vehicleId, vehicleId),
    inArray(bookings.status, ["pending", "confirmed", "picked_up"]),
    lt(bookings.startAt, newBufferEnd),
    gt(bookings.bufferEndAt, startAt),
  )).limit(1);
  if (clashing.length > 0) return { available: false, reason: "Those dates are already booked" };

  const blocked = await db.select({ id: availabilityBlocks.id }).from(availabilityBlocks).where(and(
    eq(availabilityBlocks.vehicleId, vehicleId),
    lt(availabilityBlocks.startAt, endAt),
    gt(availabilityBlocks.endAt, startAt),
  )).limit(1);
  if (blocked.length > 0) return { available: false, reason: "Vehicle is unavailable on those dates" };

  // Blackouts are whole LOCAL days. A rental touches local day D iff its window
  // overlaps [D 00:00, D+1 00:00). firstDay is the pickup's local day; the
  // exclusive end day is the return day itself when the return is at 00:00
  // (touches none of it), otherwise the day after the return day.
  const firstDay = arubaDateOf(startAt);
  const endExclusiveDay = arubaTimeOf(endAt) === "00:00"
    ? arubaDateOf(endAt)
    : arubaDateOf(addHoursIso(endAt, 24));
  const blackout = await db.select({ id: blackoutDates.id }).from(blackoutDates).where(and(
    lt(blackoutDates.startDate, endExclusiveDay),
    gt(blackoutDates.endDate, firstDay),
  )).limit(1);
  if (blackout.length > 0) return { available: false, reason: "We are closed on those dates" };

  return { available: true };
}

/** Whether a limited-stock add-on can take `qty` more across overlapping dates.
 *  null stock = unlimited. Counts committed qty on pending|confirmed bookings
 *  whose ranges overlap [start, end). Returns the remaining headroom. */
export async function addOnHeadroom(addOnId: string, stock: number | null, startAt: string, endAt: string, excludeBookingId?: string): Promise<number> {
  if (stock === null) return Number.POSITIVE_INFINITY;
  const db = await getDb();
  const rows = await db
    .select({ used: sql<number>`coalesce(sum(${bookingAddOns.qty}), 0)` })
    .from(bookingAddOns)
    .innerJoin(bookings, eq(bookingAddOns.bookingId, bookings.id))
    .where(and(
      eq(bookingAddOns.addOnId, addOnId),
      inArray(bookings.status, ["pending", "confirmed", "picked_up"]),
      excludeBookingId ? ne(bookings.id, excludeBookingId) : sql`true`,
      lt(bookings.startAt, endAt),
      gt(bookings.endAt, startAt),
    ));
  const used = Number(rows[0]?.used ?? 0);
  return stock - used;
}
