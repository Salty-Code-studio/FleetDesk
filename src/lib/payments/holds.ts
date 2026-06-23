/**
 * Unpaid-hold expiry: a pending booking that never gets paid would tie up a car
 * forever (the exclusion constraint counts pending bookings). This cancels
 * pending holds older than the TTL that have no succeeded payment, freeing the
 * slot (cancelled bookings fall outside the constraint). The scheduled run is
 * Plan 07 ops; the function + an admin trigger live here.
 */
import { and, eq, lt, ne, notExists } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { bookings, payments } from "@/lib/db/schema";

export async function expireStaleHolds(ttlMinutes: number, now = new Date()): Promise<number> {
  const db = await getDb();
  const cutoff = new Date(now.getTime() - ttlMinutes * 60_000);

  const cancelled = await db.update(bookings)
    .set({ status: "cancelled", updatedAt: now })
    .where(and(
      eq(bookings.status, "pending"),
      lt(bookings.createdAt, cutoff),
      // Never cancel a booking that has any LIVE payment (pending or succeeded).
      // A customer mid-checkout has a pending payment row; cancelling them would
      // strand a real charge once the webhook lands. Only holds with no live
      // payment activity (none, or only failed) are expired.
      notExists(
        db.select({ one: payments.id }).from(payments)
          .where(and(eq(payments.bookingId, bookings.id), ne(payments.status, "failed"))),
      ),
    ))
    .returning({ id: bookings.id });

  return cancelled.length;
}
