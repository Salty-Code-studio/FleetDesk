import { z } from "zod";
import { eq, and, ne, inArray, lt, gt, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { bookings, vehicles, bookingAddOns, addOns } from "@/lib/db/schema";
import { Errors } from "@/lib/http/errors";
import { translateDbError } from "@/lib/db/errors";
import { getSettings } from "@/lib/admin/settings";
import { rentalDays, quote, type QuoteBreakdown } from "@/lib/booking/quote";
import { isoDate } from "@/lib/validation/iso-date";

/**
 * Drag-to-move on the ops board. Any subset of {vehicleId, startDate, endDate}
 * may change. The recomputed range is re-validated by the same physical
 * exclusion constraint that guards creation, so a move into an occupied slot
 * (on the same or a different car) is rejected at the database level. Soft
 * guardrails (lead time, length) are skipped — the desk owns these decisions.
 */
export const MoveSchema = z.object({
  vehicleId: z.string().uuid().optional(),
  startDate: isoDate.optional(),
  endDate: isoDate.optional(),
}).strict();
export type MoveInput = z.infer<typeof MoveSchema>;

export async function moveBooking(id: string, input: MoveInput) {
  const db = await getDb();
  const settings = await getSettings();
  try {
    return await db.transaction(async (tx) => {
      const [booking] = await tx.select().from(bookings).where(eq(bookings.id, id)).for("update");
      if (!booking) throw Errors.notFound("Booking not found");
      if (booking.status !== "pending" && booking.status !== "confirmed") {
        throw Errors.conflict("This booking can no longer be moved");
      }

      const vehicleId = input.vehicleId ?? booking.vehicleId;
      const startDate = input.startDate ?? booking.startDate;
      const endDate = input.endDate ?? booking.endDate;
      if (endDate <= startDate) throw Errors.badRequest("Return must be after pick-up");

      const [vehicle] = await tx.select().from(vehicles).where(eq(vehicles.id, vehicleId));
      if (!vehicle || vehicle.status === "retired") throw Errors.notFound("Target vehicle not available");

      const bufferEndDate = new Date(Date.parse(`${endDate}T00:00:00Z`) + settings.turnaroundBufferDays * 86_400_000)
        .toISOString().slice(0, 10);

      // Online bookings carry add-ons and a date/vehicle-derived price snapshot.
      // Re-validate limited add-on stock over the NEW window AND re-price, so a
      // move can neither oversell shared equipment nor leave a stale total on the
      // booking, the confirmation email, and revenue reports. Manual bookings
      // hold a flat desk-set amount and no add-ons → left untouched.
      let priceBreakdown = booking.priceBreakdown as QuoteBreakdown;
      if (booking.source === "online") {
        const lines = await tx.select({
          addOnId: bookingAddOns.addOnId, qty: bookingAddOns.qty,
          name: addOns.name, priceCents: addOns.priceCents, pricing: addOns.pricing, stock: addOns.stock,
        }).from(bookingAddOns).innerJoin(addOns, eq(bookingAddOns.addOnId, addOns.id))
          .where(eq(bookingAddOns.bookingId, id));

        // Lock limited add-ons in a deterministic (sorted) order, then recount
        // committed qty over the NEW window EXCLUDING this booking.
        const limited = lines.filter((l) => l.stock !== null)
          .sort((a, b) => (a.addOnId < b.addOnId ? -1 : a.addOnId > b.addOnId ? 1 : 0));
        for (const l of limited) {
          await tx.select({ id: addOns.id }).from(addOns).where(eq(addOns.id, l.addOnId)).for("update");
          const [used] = await tx.select({ used: sql<number>`coalesce(sum(${bookingAddOns.qty}), 0)` })
            .from(bookingAddOns).innerJoin(bookings, eq(bookingAddOns.bookingId, bookings.id))
            .where(and(
              eq(bookingAddOns.addOnId, l.addOnId),
              ne(bookings.id, id),
              inArray(bookings.status, ["pending", "confirmed"]),
              lt(bookings.startDate, endDate),
              gt(bookings.endDate, startDate),
            ));
          const headroom = (l.stock as number) - Number(used?.used ?? 0);
          if (l.qty > headroom) throw Errors.conflict(`Only ${Math.max(0, headroom)} of "${l.name}" left for those dates`);
        }

        const days = rentalDays(startDate, endDate);
        priceBreakdown = quote({
          days,
          vehicle: {
            priceDayCents: vehicle.priceDayCents,
            priceWeekCents: vehicle.priceWeekCents,
            priceMonthCents: vehicle.priceMonthCents,
            depositCents: vehicle.depositCents,
          },
          insurance: (booking.insuranceSnapshot as { id: string; name: string; dailyPriceCents: number } | null) ?? null,
          addOns: lines.map((l) => ({ id: l.addOnId, name: l.name, priceCents: l.priceCents, pricing: l.pricing, qty: l.qty })),
          reservationFeeCents: settings.reservationFeeCents,
          currency: settings.currency,
        });
        // Refresh each add-on's per-line snapshot (per_day lines scale with days).
        for (const line of priceBreakdown.addOns) {
          await tx.update(bookingAddOns).set({ priceSnapshotCents: line.cents })
            .where(and(eq(bookingAddOns.bookingId, id), eq(bookingAddOns.addOnId, line.id)));
        }
      }

      const [updated] = await tx.update(bookings)
        .set({ vehicleId, startDate, endDate, bufferEndDate, priceBreakdown, updatedAt: new Date() })
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

/**
 * Admin cancel from the board. Frees the slot immediately: the exclusion
 * constraint only spans pending/confirmed rows, so flipping to cancelled lets a
 * new booking reuse the range. Terminal states (cancelled/completed) are inert.
 */
export async function cancelBookingAdmin(id: string) {
  const db = await getDb();
  const [booking] = await db.select().from(bookings).where(eq(bookings.id, id));
  if (!booking) throw Errors.notFound("Booking not found");
  if (booking.status === "cancelled" || booking.status === "completed") {
    throw Errors.conflict("This booking can no longer be cancelled");
  }
  const [updated] = await db.update(bookings)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(eq(bookings.id, id))
    .returning();
  return updated!;
}
