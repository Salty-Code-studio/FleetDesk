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
import { validateLicense, encryptLicense, driverAgeBand, type LicenseInput } from "@/lib/booking/license";
import { arubaDateOf, parseTs } from "@/lib/time/format";

export interface LicenseSaveResult {
  /** The band the licence DOB puts the driver in at pick-up. */
  band: "young" | "standard";
  /** Whether the booking was priced with the young driver fee. */
  bookedYoung: boolean;
  mismatch: boolean;
}

export async function saveBookingLicense(bookingId: string, license: LicenseInput, nowIso: string): Promise<LicenseSaveResult> {
  const db = await getDb();
  const [booking] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
  if (!booking) throw Errors.notFound("Booking not found");
  if (booking.status === "cancelled") throw Errors.conflict("This booking is cancelled");

  const settings = await getSettings();
  const pickupDate = arubaDateOf(booking.startAt);
  validateLicense(license, {
    minDriverAge: settings.minDriverAge,
    rentalStart: pickupDate,
    rentalEnd: arubaDateOf(booking.endAt),
    today: arubaDateOf(nowIso),
  });
  // validateLicense already refused under_min, so only two bands remain.
  const band = driverAgeBand(license.dob, pickupDate, settings) === "young" ? "young" : "standard";
  const bookedYoung = (booking.priceBreakdown as Partial<QuoteBreakdown>).youngDriver ?? false;

  const enc = encryptLicense(booking.id, license);
  const retainUntil = new Date(parseTs(booking.endAt) + settings.licenseRetentionDays * 86_400_000);
  await db.insert(driverLicenses)
    .values({ bookingId: booking.id, ...enc, retainUntil })
    .onConflictDoUpdate({
      target: driverLicenses.bookingId,
      set: { ...enc, retainUntil, createdAt: sql`now()` },
    });

  return { band, bookedYoung, mismatch: (band === "young") !== bookedYoung };
}
