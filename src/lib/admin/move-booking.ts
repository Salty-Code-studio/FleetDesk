import { z } from "zod";
import { eq, and, ne, inArray, lt, gt, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { bookings, vehicles, bookingAddOns, addOns, payments } from "@/lib/db/schema";
import { Errors } from "@/lib/http/errors";
import { translateDbError } from "@/lib/db/errors";
import { getSettings } from "@/lib/admin/settings";
import { checkAvailability } from "@/lib/booking/availability";
import { rentalDays, quote, type QuoteBreakdown } from "@/lib/booking/quote";
import { applyPriceOverride, type OverridableBreakdown } from "@/lib/booking/price-override";
import { isFreeCancellation } from "@/lib/booking/cancellation";
import { refundPayment } from "@/lib/payments/refunds";
import { addHoursIso, parseTs } from "@/lib/time/format";
import { isoDateTime } from "@/lib/validation/iso-date";
import { logger } from "@/lib/logger";

/**
 * Drag-to-move on the ops board. Any subset of {vehicleId, startAt, endAt}
 * may change. The recomputed range is re-validated by the same physical
 * exclusion constraint that guards creation, so a move into an occupied slot
 * (on the same or a different car) is rejected at the database level. Soft
 * guardrails (lead time, length) are skipped — the desk owns these decisions.
 */
export const MoveSchema = z.object({
  vehicleId: z.string().uuid().optional(),
  startAt: isoDateTime.optional(),
  endAt: isoDateTime.optional(),
  /** Desk staff can explicitly move a booking over an advisory block/blackout
   *  after confirming in the UI; the physical exclusion constraint (real
   *  booking clashes) can never be overridden. */
  override: z.boolean().default(false),
}).strict();
// Input type (not infer): moveBooking is called directly (tests, internal
// callers) without going through MoveSchema.parse, so `override` — the one
// field with a default — must stay optional at the type level too.
export type MoveInput = z.input<typeof MoveSchema>;

export async function moveBooking(id: string, input: MoveInput) {
  const db = await getDb();
  const settings = await getSettings();

  // Advisory pre-check OUTSIDE the transaction: checkAvailability opens its own
  // connection via getDb(), and PGlite (the test/dev driver) is single-connection
  // — calling it from inside db.transaction() deadlocks. This mirrors the same
  // pre-transaction placement createBooking already uses. A rare race between
  // this read and the transaction below is fine: the physical exclusion
  // constraint (booking clashes) still guards the actual update either way; this
  // check exists only to advise on blocks/blackouts, which the constraint can't see.
  if (!input.override) {
    const [existing] = await db.select().from(bookings).where(eq(bookings.id, id));
    if (existing) {
      // A terminal-status booking (cancelled/completed) can never actually be
      // moved — the transaction below rejects it unconditionally, override or
      // not. Check that FIRST: running the advisory block/blackout check
      // before this gate would offer a misleading "book anyway" override on a
      // booking no override can save.
      if (existing.status !== "pending" && existing.status !== "confirmed") {
        throw Errors.conflict("This booking can no longer be moved");
      }
      const vehicleId = input.vehicleId ?? existing.vehicleId;
      const startAt = input.startAt ?? existing.startAt;
      const endAt = input.endAt ?? existing.endAt;
      const [vehicle] = await db.select().from(vehicles).where(eq(vehicles.id, vehicleId));
      // A missing/retired vehicle is a hard 404, never an overridable advisory —
      // let the transaction below reject it the same way it always has.
      if (vehicle && vehicle.status !== "retired" && parseTs(endAt) > parseTs(startAt)) {
        // Exclude this booking's own (pre-move) row — otherwise a date/car
        // tweak on the same booking would always "clash" with itself.
        const availability = await checkAvailability(vehicleId, startAt, endAt, settings, id);
        if (!availability.available) {
          throw Errors.conflict(`${availability.reason ?? "That range is unavailable"}. Confirm to book anyway.`, { code: "advisory_conflict" });
        }
      }
    }
  }

  try {
    return await db.transaction(async (tx) => {
      const [booking] = await tx.select().from(bookings).where(eq(bookings.id, id)).for("update");
      if (!booking) throw Errors.notFound("Booking not found");
      if (booking.status !== "pending" && booking.status !== "confirmed") {
        throw Errors.conflict("This booking can no longer be moved");
      }

      const vehicleId = input.vehicleId ?? booking.vehicleId;
      const startAt = input.startAt ?? booking.startAt;
      const endAt = input.endAt ?? booking.endAt;
      if (parseTs(endAt) <= parseTs(startAt)) throw Errors.badRequest("Return must be after pick-up");

      const [vehicle] = await tx.select().from(vehicles).where(eq(vehicles.id, vehicleId));
      if (!vehicle || vehicle.status === "retired") throw Errors.notFound("Target vehicle not available");

      const bufferEndAt = addHoursIso(endAt, settings.turnaroundBufferHours);

      // Online bookings carry add-ons and a date/vehicle-derived price snapshot.
      // Re-validate limited add-on stock over the NEW window AND re-price, so a
      // move can neither oversell shared equipment nor leave a stale total on the
      // booking, the confirmation email, and revenue reports. Manual bookings
      // hold a flat desk-set amount and no add-ons → left untouched.
      let priceBreakdown: QuoteBreakdown | OverridableBreakdown = booking.priceBreakdown as QuoteBreakdown;
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
              inArray(bookings.status, ["pending", "confirmed", "picked_up"]),
              lt(bookings.startAt, endAt),
              gt(bookings.endAt, startAt),
            ));
          const headroom = (l.stock as number) - Number(used?.used ?? 0);
          if (l.qty > headroom) throw Errors.conflict(`Only ${Math.max(0, headroom)} of "${l.name}" left for those dates`);
        }

        const days = rentalDays(startAt, endAt);
        const newBreakdown = quote({
          days,
          vehicle: {
            priceDayCents: vehicle.priceDayCents,
            priceWeekCents: vehicle.priceWeekCents,
            priceMonthCents: vehicle.priceMonthCents,
            depositCents: vehicle.depositCents,
          },
          insurance: (booking.insuranceSnapshot as { id: string; name: string; dailyPriceCents: number } | null) ?? null,
          addOns: lines.map((l) => ({ id: l.addOnId, name: l.name, priceCents: l.priceCents, pricing: l.pricing, qty: l.qty })),
          depositPercent: settings.depositPercent,
          depositMinCents: settings.depositMinCents,
          currency: settings.currency,
        });
        // Carry an owner price override across the re-quote (Task 18): the
        // adjustment is a FIXED cents amount, preserved verbatim, that must
        // NOT scale with the new duration. A move can also SHORTEN a booking,
        // so a large negative adjustment against a much smaller fresh quote is
        // clamped at 0 rather than going negative.
        const carried = (booking.priceBreakdown as OverridableBreakdown).priceOverride;
        priceBreakdown = carried
          ? applyPriceOverride(
              newBreakdown as unknown as OverridableBreakdown,
              Math.max(0, newBreakdown.subtotalCents + Number((booking.priceBreakdown as OverridableBreakdown).adjustmentCents ?? 0)),
              { reason: carried.reason, byAdminId: carried.byAdminId, at: carried.at },
            )
          : newBreakdown;
        // Refresh each add-on's per-line snapshot (per_day lines scale with days).
        for (const line of newBreakdown.addOns) {
          await tx.update(bookingAddOns).set({ priceSnapshotCents: line.cents })
            .where(and(eq(bookingAddOns.bookingId, id), eq(bookingAddOns.addOnId, line.id)));
        }
      }

      const [updated] = await tx.update(bookings)
        .set({ vehicleId, startAt, endAt, bufferEndAt, priceBreakdown, updatedAt: new Date() })
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

export interface AdminCancelledBooking {
  id: string;
  status: string;
  refunded: boolean;
  refundCents: number;
  refundError: boolean;
  policySaysFree: boolean;
}

/**
 * Admin cancel from the board. Frees the slot immediately: the exclusion
 * constraint only spans pending/confirmed rows, so flipping to cancelled lets a
 * new booking reuse the range. Terminal states (cancelled/completed) are inert.
 *
 * `refund` is the admin's explicit choice (the UI always states it, no silent
 * default): true refunds every succeeded payment in full as a goodwill
 * override, regardless of the cancellation window; false never touches
 * Stripe. `policySaysFree` reports what the window policy alone would decide
 * (spec §16) — it is purely informational for the response/UI and never gates
 * the refund itself. A refund that errors never blocks the cancellation, it
 * just gets logged loudly for a retry from the Drawer.
 */
export async function cancelBookingAdmin(id: string, refund: boolean, nowIso: string): Promise<AdminCancelledBooking> {
  const db = await getDb();
  const [booking] = await db.select().from(bookings).where(eq(bookings.id, id));
  if (!booking) throw Errors.notFound("Booking not found");
  // Allow-list, not deny-list: only pending/confirmed can be cancelled. A
  // picked_up car is OUT — it must come back through check-out, never a cancel
  // (the exclusion constraint keeps its slot reserved while it's gone).
  if (booking.status !== "pending" && booking.status !== "confirmed") {
    throw Errors.conflict("This booking can no longer be cancelled");
  }
  const [updated] = await db.update(bookings)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(eq(bookings.id, id))
    .returning();

  const settings = await getSettings();
  const policySaysFree = isFreeCancellation(booking, settings, nowIso);

  let refundCents = 0;
  let refundError = false;
  if (refund) {
    const succeeded = await db.select().from(payments)
      .where(and(eq(payments.bookingId, id), eq(payments.status, "succeeded")));
    for (const p of succeeded) {
      try {
        // Use the delta refundPayment actually applied inside its own locked
        // transaction, not a difference against this pre-transaction `p`
        // read: a concurrent refund between the select above and this call
        // would otherwise inflate the reported/emailed refundCents.
        const r = await refundPayment(p.id);
        refundCents += r.appliedCents;
      } catch (e) {
        refundError = true;
        logger.error("admin_cancel_refund_failed", { bookingId: id, paymentId: p.id, error: (e as Error).message });
      }
    }
  }

  return {
    id: updated!.id,
    status: updated!.status,
    refunded: refundCents > 0,
    refundCents,
    refundError,
    policySaysFree,
  };
}
