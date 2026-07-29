import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { bookings, vehicles } from "@/lib/db/schema";
import { Errors } from "@/lib/http/errors";
import { translateDbError } from "@/lib/db/errors";
import { getSettings } from "@/lib/admin/settings";
import { checkAvailability } from "@/lib/booking/availability";

/**
 * Breakdown swap: move a booking onto a replacement car when its assigned car is
 * out of action, WITHOUT touching the dates or the price. This is the deliberate
 * counterpart to {@link moveBooking}:
 *
 *  - it works for a `picked_up` booking too (the car is out with the customer and
 *    has broken down) — the status is preserved, only the vehicle changes;
 *  - it never re-quotes. A breakdown is not the customer's fault, so the original
 *    price snapshot, add-on lines and totals are left exactly as they were, even
 *    if the replacement car normally costs more or less.
 *
 * The replacement car is still guarded by the same physical exclusion constraint
 * as everything else, so a swap can never double-book a car. A soft block/blackout
 * on the target surfaces as an `advisory_conflict` the desk can explicitly
 * override; a real booking clash can never be overridden.
 */
export const SwapSchema = z.object({
  vehicleId: z.string().uuid(),
  override: z.boolean().default(false),
}).strict();
// Input (not infer): swapVehicle is called directly in tests/internal callers
// without SwapSchema.parse, so `override` (the field with a default) stays
// optional at the type level.
export type SwapInput = z.input<typeof SwapSchema>;

const NOT_SWAPPABLE = "This booking can no longer be swapped";
const PICK_DIFFERENT = "Pick a different car to swap to";

/** Statuses whose car can still be swapped. A picked_up car is out with the
 *  customer but can break down mid-rental, so it is included (unlike moving,
 *  which only shifts dates on a car that has not left yet). */
function isSwappable(status: string): boolean {
  return status === "pending" || status === "confirmed" || status === "picked_up";
}

export async function swapVehicle(id: string, input: SwapInput) {
  const db = await getDb();
  const settings = await getSettings();

  // Advisory pre-check OUTSIDE the transaction (checkAvailability opens its own
  // connection; PGlite is single-connection so calling it inside db.transaction()
  // deadlocks — same placement moveBooking uses). A rare race is harmless: the
  // physical exclusion constraint still guards the update below either way.
  if (!input.override) {
    const [existing] = await db.select().from(bookings).where(eq(bookings.id, id));
    if (existing) {
      // A terminal booking can never be swapped, override or not — check that
      // FIRST so it never surfaces a misleading "swap anyway" advisory offer.
      if (!isSwappable(existing.status)) throw Errors.conflict(NOT_SWAPPABLE);
      if (input.vehicleId === existing.vehicleId) throw Errors.badRequest(PICK_DIFFERENT);
      const [vehicle] = await db.select().from(vehicles).where(eq(vehicles.id, input.vehicleId));
      // A missing/retired target is a hard error below, never an overridable advisory.
      if (vehicle && vehicle.status !== "retired") {
        // Same dates as today; exclude this booking's own row so it can't clash with itself.
        const availability = await checkAvailability(input.vehicleId, existing.startAt, existing.endAt, settings, id);
        if (!availability.available) {
          throw Errors.conflict(`${availability.reason ?? "That car is unavailable"}. Confirm to swap anyway.`, { code: "advisory_conflict" });
        }
      }
    }
  }

  try {
    return await db.transaction(async (tx) => {
      const [booking] = await tx.select().from(bookings).where(eq(bookings.id, id)).for("update");
      if (!booking) throw Errors.notFound("Booking not found");
      if (!isSwappable(booking.status)) throw Errors.conflict(NOT_SWAPPABLE);
      if (input.vehicleId === booking.vehicleId) throw Errors.badRequest(PICK_DIFFERENT);

      const [vehicle] = await tx.select().from(vehicles).where(eq(vehicles.id, input.vehicleId));
      if (!vehicle || vehicle.status === "retired") throw Errors.notFound("Target vehicle not available");

      // Vehicle only. Dates, buffer, status, price and add-on snapshots are all
      // left as-is — the physical exclusion constraint re-validates the new
      // (vehicle, range) on write, rejecting a real clash with a 23P01 → 409.
      const [updated] = await tx.update(bookings)
        .set({ vehicleId: input.vehicleId, updatedAt: new Date() })
        .where(eq(bookings.id, id))
        .returning();
      return updated!;
    });
  } catch (e) {
    const t = translateDbError(e); // 23P01 overlap+buffer → 409
    if (t) throw t;
    throw e;
  }
}
