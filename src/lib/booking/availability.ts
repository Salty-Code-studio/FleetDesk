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
import { Errors } from "@/lib/http/errors";

export interface DateGuardSettings {
  minRentalDays: number;
  maxRentalDays: number;
  maxAdvanceDays: number;
  turnaroundBufferDays: number;
}

/** Throws a 400 with a clear, user-facing message if the dates break a
 *  guardrail. `today` is YYYY-MM-DD. */
export function validateDates(startDate: string, endDate: string, settings: DateGuardSettings, today: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    throw Errors.badRequest("Dates must be YYYY-MM-DD");
  }
  const days = rentalDays(startDate, endDate);
  if (days <= 0) throw Errors.badRequest("Return must be after pick-up");
  if (startDate < today) throw Errors.badRequest("Pick-up cannot be in the past");
  if (days < settings.minRentalDays) throw Errors.badRequest(`Minimum rental is ${settings.minRentalDays} day(s)`);
  if (days > settings.maxRentalDays) throw Errors.badRequest(`Maximum rental is ${settings.maxRentalDays} day(s)`);
  const advance = rentalDays(today, startDate);
  if (advance > settings.maxAdvanceDays) throw Errors.badRequest(`Bookings open at most ${settings.maxAdvanceDays} day(s) ahead`);
}

/** Shift a YYYY-MM-DD date by N days, returning YYYY-MM-DD. */
function addDays(date: string, n: number): string {
  const t = Date.parse(`${date}T00:00:00Z`) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
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
  startDate: string,
  endDate: string,
  settings: { turnaroundBufferDays: number },
): Promise<AvailabilityResult> {
  const db = await getDb();

  const [vehicle] = await db.select().from(vehicles).where(eq(vehicles.id, vehicleId));
  if (!vehicle) return { available: false, reason: "Vehicle not found" };
  if (vehicle.status !== "active") return { available: false, reason: "Vehicle is not available" };

  // Mirror the DB exclusion rule EXACTLY: it overlaps daterange(start, bufferEnd)
  // using each row's OWN stored buffer_end_date (frozen at its creation). The new
  // booking will store bufferEnd = end + the CURRENT buffer. Two ranges overlap
  // iff existing.start < newBufferEnd AND existing.bufferEnd > newStart. Comparing
  // against each row's stored bufferEnd (not a freshly re-derived buffer) means
  // raising turnaroundBufferDays after older bookings exist no longer over-rejects
  // a slot the authoritative constraint would actually accept.
  const newBufferEnd = addDays(endDate, settings.turnaroundBufferDays);

  const clashing = await db.select({ id: bookings.id }).from(bookings).where(and(
    eq(bookings.vehicleId, vehicleId),
    inArray(bookings.status, ["pending", "confirmed"]),
    lt(bookings.startDate, newBufferEnd),
    gt(bookings.bufferEndDate, startDate),
  )).limit(1);
  if (clashing.length > 0) return { available: false, reason: "Those dates are already booked" };

  const blocked = await db.select({ id: availabilityBlocks.id }).from(availabilityBlocks).where(and(
    eq(availabilityBlocks.vehicleId, vehicleId),
    lt(availabilityBlocks.startDate, endDate),
    gt(availabilityBlocks.endDate, startDate),
  )).limit(1);
  if (blocked.length > 0) return { available: false, reason: "Vehicle is unavailable on those dates" };

  const blackout = await db.select({ id: blackoutDates.id }).from(blackoutDates).where(and(
    lt(blackoutDates.startDate, endDate),
    gt(blackoutDates.endDate, startDate),
  )).limit(1);
  if (blackout.length > 0) return { available: false, reason: "We are closed on those dates" };

  return { available: true };
}

/** Whether a limited-stock add-on can take `qty` more across overlapping dates.
 *  null stock = unlimited. Counts committed qty on pending|confirmed bookings
 *  whose ranges overlap [start, end). Returns the remaining headroom. */
export async function addOnHeadroom(addOnId: string, stock: number | null, startDate: string, endDate: string, excludeBookingId?: string): Promise<number> {
  if (stock === null) return Number.POSITIVE_INFINITY;
  const db = await getDb();
  const rows = await db
    .select({ used: sql<number>`coalesce(sum(${bookingAddOns.qty}), 0)` })
    .from(bookingAddOns)
    .innerJoin(bookings, eq(bookingAddOns.bookingId, bookings.id))
    .where(and(
      eq(bookingAddOns.addOnId, addOnId),
      inArray(bookings.status, ["pending", "confirmed"]),
      excludeBookingId ? ne(bookings.id, excludeBookingId) : sql`true`,
      lt(bookings.startDate, endDate),
      gt(bookings.endDate, startDate),
    ));
  const used = Number(rows[0]?.used ?? 0);
  return stock - used;
}
