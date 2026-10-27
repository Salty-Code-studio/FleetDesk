/**
 * Licence capture at check-in (Flow Desk phase 4). The public funnel no longer
 * asks for the driver's licence, so the desk types it in at handover. This is
 * where the age gate now runs for those bookings: an under-age or expiring
 * licence is refused, and a young-driver mismatch with the claimed age band is
 * reported, never silently repriced (the desk decides with the price tools).
 */
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { bookings, driverLicenses } from "@/lib/db/schema";
import { Errors } from "@/lib/http/errors";
import { getSettings } from "@/lib/admin/settings";
import type { QuoteBreakdown } from "@/lib/booking/quote";
import { validateLicense, encryptLicense, driverAgeBand, ageOn, type LicenseInput } from "@/lib/booking/license";
import { arubaDateOf, parseTs } from "@/lib/time/format";

export interface LicenceCheck {
  /** The band the licence DOB puts the driver in at pick-up. */
  band: "young" | "standard";
  /** Whether the booking was priced with the young driver fee. */
  bookedYoung: boolean;
  mismatch: boolean;
}
export type LicenseSaveResult = LicenceCheck;

/** Compare a licence DOB with the band the booking was priced with. Pure;
 *  the handover recomputes it on every read so the warning survives a reload. */
export function licenceCheckFor(
  dob: string,
  startAt: string,
  bookedYoung: boolean,
  s: { minDriverAge: number; youngDriverAge: number },
): LicenceCheck {
  const band = driverAgeBand(dob, arubaDateOf(startAt), s) === "young" ? "young" : "standard";
  return { band, bookedYoung, mismatch: (band === "young") !== bookedYoung };
}

export async function saveBookingLicense(bookingId: string, license: LicenseInput, nowIso: string): Promise<LicenseSaveResult> {
  const db = await getDb();
  const [booking] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
  if (!booking) throw Errors.notFound("Booking not found");
  if (booking.status === "cancelled") throw Errors.conflict("This booking is cancelled");
  // A finished rental's licence is left to the retention sweep, never rewritten.
  if (booking.status === "completed") throw Errors.conflict("This rental is already closed");

  const settings = await getSettings();
  const pickupDate = arubaDateOf(booking.startAt);
  // The funnel only asks for an age band, so an under-age driver can arrive
  // with a paid booking. Tell the desk what to do, not just what is wrong.
  if (/^\d{4}-\d{2}-\d{2}$/.test(license.dob) && ageOn(license.dob, pickupDate) < settings.minDriverAge) {
    throw Errors.badRequest(
      `Driver must be at least ${settings.minDriverAge} years old. Do not hand over the car. Cancel the booking and refund it from the booking sheet.`,
    );
  }
  validateLicense(license, {
    minDriverAge: settings.minDriverAge,
    rentalStart: pickupDate,
    rentalEnd: arubaDateOf(booking.endAt),
    today: arubaDateOf(nowIso),
  });
  const bookedYoung = (booking.priceBreakdown as Partial<QuoteBreakdown>).youngDriver ?? false;

  const enc = encryptLicense(booking.id, license);
  const retainUntil = new Date(parseTs(booking.endAt) + settings.licenseRetentionDays * 86_400_000);
  await db.insert(driverLicenses)
    .values({ bookingId: booking.id, ...enc, retainUntil })
    .onConflictDoUpdate({
      target: driverLicenses.bookingId,
      set: { ...enc, retainUntil, createdAt: sql`now()` },
    });

  return licenceCheckFor(license.dob, booking.startAt, bookedYoung, settings);
}
