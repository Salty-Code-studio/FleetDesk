import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { bookings, vehicles, bookingAddOns, addOns, payments } from "@/lib/db/schema";
import { Errors } from "@/lib/http/errors";
import { translateDbError } from "@/lib/db/errors";
import { getSettings } from "@/lib/admin/settings";
import { checkAvailability } from "@/lib/booking/availability";
import { rentalDays, quote, type QuoteBreakdown } from "@/lib/booking/quote";
import { createExtensionCheckout } from "@/lib/payments/checkout";
import { addHoursIso, parseTs } from "@/lib/time/format";
import type { AdminRole } from "@/lib/auth/admin-auth";

/**
 * Push a live rental's return date out. Only a booking that is on the road or
 * paid-and-waiting (confirmed | picked_up) can be extended, and only into a slot
 * the car is actually free for. The FULL new duration is re-priced so the
 * booking, its confirmation, and revenue reports all carry one honest total; the
 * customer pays only the DELTA, either at the desk (settled on the spot) or by a
 * Stripe link (settled by the signed webhook, per webhook.ts).
 *
 * Money truth: vehicle rates are re-read from the CURRENT catalog, but insurance
 * and add-on UNIT prices come from the booking's own SNAPSHOT, so the customer
 * keeps every locked-in price. The delta is floored at zero — extending into a
 * cheaper tier never bills the customer a negative amount.
 */
const EXTENDABLE = ["confirmed", "picked_up"] as const;

export interface ExtendResult {
  booking: typeof bookings.$inferSelect;
  deltaCents: number;
  checkoutUrl: string | null;
  /** The return date BEFORE the extension — the route uses it for the audit diff. */
  previousEndAt: string;
}

// Thrown INSIDE the transaction to unwind it (dryRun mode): Drizzle rolls back
// every statement run so far when the callback throws, so this guarantees zero
// writes while still letting us carry the computed delta back out.
class DryRunPreview extends Error {
  constructor(readonly deltaCents: number) {
    super("dry run: no write performed");
  }
}

export async function extendBooking(
  id: string,
  opts: { endAt: string; payment: "link" | "desk"; dryRun?: boolean; role: AdminRole },
): Promise<ExtendResult> {
  const db = await getDb();
  const settings = await getSettings();
  const newEndAt = opts.endAt;
  const isExtendable = (s: string) => (EXTENDABLE as readonly string[]).includes(s);

  // Advisory availability pre-check OUTSIDE the transaction: checkAvailability
  // opens its own getDb() connection and PGlite (dev/test) is single-connection,
  // so calling it inside db.transaction() deadlocks. This mirrors move/create.
  // The physical exclusion constraint on the UPDATE below is the hard backstop.
  const [existing] = await db.select().from(bookings).where(eq(bookings.id, id));
  if (!existing) throw Errors.notFound("Booking not found");
  if (!isExtendable(existing.status)) throw Errors.conflict("Only a confirmed or picked-up booking can be extended");
  if (parseTs(newEndAt) <= parseTs(existing.endAt)) throw Errors.badRequest("The new return must be after the current return");

  // Money gate: settling the delta at the desk records a SUCCEEDED cash
  // payment and immediately bumps amountPaidCents, same as the owner-only
  // recordDeskBalancePayment capability. Staff may still send a Stripe link
  // (that makes the CUSTOMER pay; it never touches the ledger here). Skipped
  // for a dryRun: it never writes, and the drawer always previews with
  // payment:"desk" regardless of role just to show the live delta number.
  if (!opts.dryRun && opts.payment === "desk" && opts.role !== "owner") {
    throw Errors.forbidden("Only an owner can record a desk payment for a booking extension");
  }

  // Only the ADDED tail [currentEndAt, newEndAt) has to be free; exclude this
  // booking's own row so it never clashes with itself.
  const avail = await checkAvailability(existing.vehicleId, existing.endAt, newEndAt, settings, id);
  if (!avail.available) throw Errors.conflict(avail.reason ?? "Those dates are already booked");

  try {
    const { booking, deltaCents, needsLink, previousEndAt } = await db.transaction(async (tx) => {
      const [b] = await tx.select().from(bookings).where(eq(bookings.id, id)).for("update");
      if (!b) throw Errors.notFound("Booking not found");
      if (!isExtendable(b.status)) throw Errors.conflict("Only a confirmed or picked-up booking can be extended");
      if (parseTs(newEndAt) <= parseTs(b.endAt)) throw Errors.badRequest("The new return must be after the current return");

      const prevEnd = b.endAt;
      const oldBreakdown = b.priceBreakdown as QuoteBreakdown;
      const [vehicle] = await tx.select().from(vehicles).where(eq(vehicles.id, b.vehicleId));
      if (!vehicle) throw Errors.notFound("Vehicle not found");

      // ── RE-QUOTE BLOCK (keep as one unit — wave 05 T6 extends it to preserve
      //    the young-driver line). Vehicle rates: CURRENT catalog. Insurance +
      //    add-on unit prices: the booking's SNAPSHOT, so locked-in prices hold. ──
      const newDays = rentalDays(b.startAt, newEndAt);
      const oldDays = oldBreakdown.days ?? rentalDays(b.startAt, prevEnd);
      const lines = await tx.select({
        addOnId: bookingAddOns.addOnId, qty: bookingAddOns.qty, snapshotCents: bookingAddOns.priceSnapshotCents,
        name: addOns.name, pricing: addOns.pricing,
      }).from(bookingAddOns).innerJoin(addOns, eq(bookingAddOns.addOnId, addOns.id))
        .where(eq(bookingAddOns.bookingId, id));
      // Recover each line's snapshot UNIT price from its stored line total, so the
      // re-quote scales per_day lines to the new day count at the ORIGINAL unit
      // price and leaves per_rental lines unchanged.
      const quoteAddOns = lines.map((l) => {
        const units = l.pricing === "per_day" ? Math.max(1, oldDays) * l.qty : l.qty;
        const snapshotUnitCents = Math.round(l.snapshotCents / Math.max(1, units));
        return { id: l.addOnId, name: l.name, priceCents: snapshotUnitCents, pricing: l.pricing, qty: l.qty };
      });
      const newBreakdown = quote({
        days: newDays,
        vehicle: {
          priceDayCents: vehicle.priceDayCents,
          priceWeekCents: vehicle.priceWeekCents,
          priceMonthCents: vehicle.priceMonthCents,
          depositCents: vehicle.depositCents,
        },
        insurance: (b.insuranceSnapshot as { id: string; name: string; dailyPriceCents: number } | null) ?? null,
        addOns: quoteAddOns,
        depositPercent: oldBreakdown.depositPercent ?? settings.depositPercent,
        depositMinCents: oldBreakdown.depositMinCents ?? settings.depositMinCents,
        currency: oldBreakdown.currency ?? settings.currency,
        youngDriver: oldBreakdown.youngDriver ?? false,
        youngDriverFeeCentsPerDay: settings.youngDriverFeeCentsPerDay,
      });
      const deltaCents = Math.max(0, newBreakdown.subtotalCents - (oldBreakdown.subtotalCents ?? 0));
      // ── end re-quote block ──

      // dryRun: the caller only wants the live preview number. Unwind the
      // transaction (nothing has been written yet) instead of committing.
      if (opts.dryRun) throw new DryRunPreview(deltaCents);

      const bufferEndAt = addHoursIso(newEndAt, settings.turnaroundBufferHours);
      const isDeskPaid = opts.payment === "desk" && deltaCents > 0;
      const [updated] = await tx.update(bookings)
        .set(isDeskPaid
          ? { endAt: newEndAt, bufferEndAt, priceBreakdown: newBreakdown, amountPaidCents: sql`${bookings.amountPaidCents} + ${deltaCents}`, updatedAt: new Date() }
          : { endAt: newEndAt, bufferEndAt, priceBreakdown: newBreakdown, updatedAt: new Date() })
        .where(eq(bookings.id, id))
        .returning();

      // Refresh each add-on's per-line snapshot so reports match the new duration
      // (per_day lines scale; each line keeps its locked-in unit price).
      for (const line of newBreakdown.addOns) {
        await tx.update(bookingAddOns).set({ priceSnapshotCents: line.cents })
          .where(and(eq(bookingAddOns.bookingId, id), eq(bookingAddOns.addOnId, line.id)));
      }

      // Desk path: settle the delta on the spot as a succeeded desk payment
      // (skip a zero charge). Link path defers to createExtensionCheckout below.
      if (isDeskPaid) {
        await tx.insert(payments).values({
          bookingId: id, type: "extension", method: "desk",
          amountCents: deltaCents, currency: newBreakdown.currency, status: "succeeded",
        });
      }

      return { booking: updated!, deltaCents, needsLink: opts.payment === "link" && deltaCents > 0, previousEndAt: prevEnd };
    });

    // Link path: after the dates are committed, stand up a Stripe checkout for
    // the delta and a pending extension payment (the webhook settles it — Task 2).
    let checkoutUrl: string | null = null;
    if (needsLink) {
      const checkout = await createExtensionCheckout(booking, deltaCents);
      checkoutUrl = checkout.url;
    }

    return { booking, deltaCents, checkoutUrl, previousEndAt };
  } catch (e) {
    if (e instanceof DryRunPreview) {
      return { booking: existing, deltaCents: e.deltaCents, checkoutUrl: null, previousEndAt: existing.endAt };
    }
    const t = translateDbError(e); // 23P01 overlap+buffer → 409 backstop
    if (t) throw t;
    throw e;
  }
}
