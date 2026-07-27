/**
 * Booking creation (spec §6, §7, §8). One transaction: upsert the customer,
 * insert the booking (the Postgres exclusion constraint is the HARD guarantee
 * that two bookings can never hold the same vehicle on overlapping dates),
 * insert the add-on snapshots, and insert the encrypted driver's licence.
 *
 * Money is ALWAYS recomputed server-side and snapshotted; the client's numbers
 * are ignored. The idempotency key makes a double-submit return the SAME
 * booking instead of creating two.
 */
import { z } from "zod";
import { eq, and, inArray, lt, gt, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import {
  vehicles, customers, bookings, bookingAddOns, addOns, insuranceTiers, driverLicenses,
} from "@/lib/db/schema";
import { Errors } from "@/lib/http/errors";
import { isUniqueViolation, translateDbError } from "@/lib/db/errors";
import { getSettings } from "@/lib/admin/settings";
import { getLatestPolicy } from "@/lib/admin/policies";
import { rentalDays, quote, type QuoteBreakdown } from "@/lib/booking/quote";
import { validateDates, checkAvailability } from "@/lib/booking/availability";
import { LicenseSchema, validateLicense, encryptLicense } from "@/lib/booking/license";
import { addHoursIso, arubaDateOf, parseTs } from "@/lib/time/format";
import { isoDateTime } from "@/lib/validation/iso-date";

export const BookingCreateSchema = z.object({
  vehicleSlug: z.string().trim().min(1).max(80),
  startAt: isoDateTime,
  endAt: isoDateTime,
  customer: z.object({
    email: z.string().trim().toLowerCase().email().max(254),
    name: z.string().trim().min(1).max(120),
    phone: z.string().trim().max(40).default(""),
  }).strict(),
  insuranceTierId: z.string().uuid().nullable().optional(),
  addOns: z.array(z.object({ addOnId: z.string().uuid(), qty: z.number().int().min(1).max(10) })).max(20).default([]),
  license: LicenseSchema,
  acceptTerms: z.literal(true, { errorMap: () => ({ message: "You must accept the rental terms" }) }),
  paymentOption: z.enum(["reservation_fee", "full_deposit", "cash_deposit"]),
  idempotencyKey: z.string().trim().min(8).max(200),
}).strict();

export type BookingCreateInput = z.infer<typeof BookingCreateSchema>;
export type Booking = typeof bookings.$inferSelect;

export interface BookingResult {
  booking: Booking;
  breakdown: QuoteBreakdown;
  replayed: boolean;
}

export async function createBooking(input: BookingCreateInput, nowIso: string): Promise<BookingResult> {
  const db = await getDb();

  // Idempotent replay: same key returns the same booking, never a second one.
  const [existing] = await db.select().from(bookings).where(eq(bookings.idempotencyKey, input.idempotencyKey));
  if (existing) {
    return { booking: existing, breakdown: existing.priceBreakdown as QuoteBreakdown, replayed: true };
  }

  const settings = await getSettings();
  const [vehicle] = await db.select().from(vehicles).where(eq(vehicles.slug, input.vehicleSlug));
  if (!vehicle || vehicle.status !== "active") throw Errors.notFound("Vehicle not available");

  // Guardrails (throw 4xx on violation).
  validateDates(input.startAt, input.endAt, settings, nowIso);
  validateLicense(input.license, { minDriverAge: settings.minDriverAge, rentalStart: arubaDateOf(input.startAt), rentalEnd: arubaDateOf(input.endAt) });

  const availability = await checkAvailability(vehicle.id, input.startAt, input.endAt, settings);
  if (!availability.available) throw Errors.conflict(availability.reason ?? "Those dates are not available");

  if (input.paymentOption === "full_deposit" && vehicle.depositCents === null) {
    throw Errors.badRequest("Paying the full deposit online is not available for this car yet");
  }
  // A reservation_fee / cash_deposit booking is locked by charging the online
  // reservation fee. If the owner set that fee to 0 the booking would be created
  // but never chargeable (chargeForBooking throws), so reject it up front rather
  // than leave an unpayable hold tying up the car until it expires.
  if (
    (input.paymentOption === "reservation_fee" || input.paymentOption === "cash_deposit") &&
    settings.reservationFeeCents <= 0
  ) {
    throw Errors.badRequest("Online reservation is unavailable right now; please contact us to book");
  }

  // Resolve insurance tier (must be active) and add-ons (must be active).
  let insurance: { id: string; name: string; dailyPriceCents: number } | null = null;
  if (input.insuranceTierId) {
    const [tier] = await db.select().from(insuranceTiers).where(eq(insuranceTiers.id, input.insuranceTierId));
    if (!tier || !tier.active) throw Errors.badRequest("Selected insurance tier is unavailable");
    insurance = { id: tier.id, name: tier.name, dailyPriceCents: tier.dailyPriceCents };
  }

  // Dedup: the same add-on sent twice in one request is ONE line of summed qty,
  // so a duplicate can't sneak past the per-entry stock check.
  // Sorted by addOnId so the FOR UPDATE loop below acquires row locks in a
  // GLOBAL deterministic order: two concurrent bookings for the same add-ons in
  // opposite request order can never form a lock cycle (deadlock 40P01).
  const requestedAddOns = Array.from(
    input.addOns.reduce((m, a) => m.set(a.addOnId, (m.get(a.addOnId) ?? 0) + a.qty), new Map<string, number>()),
    ([addOnId, qty]) => ({ addOnId, qty }),
  ).sort((a, b) => (a.addOnId < b.addOnId ? -1 : a.addOnId > b.addOnId ? 1 : 0));
  const addOnRows = requestedAddOns.length
    ? await db.select().from(addOns).where(inArray(addOns.id, requestedAddOns.map((a) => a.addOnId)))
    : [];
  const addOnById = new Map(addOnRows.map((a) => [a.id, a]));
  for (const req of requestedAddOns) {
    const a = addOnById.get(req.addOnId);
    if (!a || !a.active) throw Errors.badRequest("An add-on is unavailable");
    if (req.qty > 10) throw Errors.badRequest(`At most 10 of "${a.name}" per booking`);
  }

  const days = rentalDays(input.startAt, input.endAt);
  const breakdown = quote({
    days,
    vehicle: {
      priceDayCents: vehicle.priceDayCents,
      priceWeekCents: vehicle.priceWeekCents,
      priceMonthCents: vehicle.priceMonthCents,
      depositCents: vehicle.depositCents,
    },
    insurance,
    addOns: requestedAddOns.map((req) => {
      const a = addOnById.get(req.addOnId)!;
      return { id: a.id, name: a.name, priceCents: a.priceCents, pricing: a.pricing, qty: req.qty };
    }),
    reservationFeeCents: settings.reservationFeeCents,
    currency: settings.currency,
  });

  const termsVersion = (await getLatestPolicy("rental_terms"))?.version ?? 0;
  const retainUntil = new Date(parseTs(input.endAt) + settings.licenseRetentionDays * 86_400_000);
  // The DB exclusion constraint runs over [start, bufferEnd) so the cleaning gap
  // is physically enforced (not just pre-checked).
  const bufferEndAt = addHoursIso(input.endAt, settings.turnaroundBufferHours);
  const now = new Date();

  try {
    return await db.transaction(async (tx) => {
      // Authoritative stock check, INSIDE the transaction: lock each limited
      // add-on row so concurrent bookings serialize, then recount committed qty
      // over overlapping dates. (App-code-only counting can't make oversell
      // impossible; the row lock closes the TOCTOU window in real Postgres.)
      for (const req of requestedAddOns) {
        const a = addOnById.get(req.addOnId)!;
        if (a.stock === null) continue; // unlimited
        await tx.select({ id: addOns.id }).from(addOns).where(eq(addOns.id, a.id)).for("update");
        const [usedRow] = await tx
          .select({ used: sql<number>`coalesce(sum(${bookingAddOns.qty}), 0)` })
          .from(bookingAddOns)
          .innerJoin(bookings, eq(bookingAddOns.bookingId, bookings.id))
          .where(and(
            eq(bookingAddOns.addOnId, a.id),
            inArray(bookings.status, ["pending", "confirmed", "picked_up"]),
            lt(bookings.startAt, input.endAt),
            gt(bookings.endAt, input.startAt),
          ));
        const headroom = a.stock - Number(usedRow?.used ?? 0);
        if (req.qty > headroom) throw Errors.conflict(`Only ${Math.max(0, headroom)} of "${a.name}" left for those dates`);
      }

      // Upsert the customer by email (passwordless verification lands in Plan 06).
      await tx.insert(customers)
        .values({ email: input.customer.email, name: input.customer.name, phone: input.customer.phone })
        .onConflictDoNothing({ target: customers.email });
      const [customer] = await tx.select().from(customers).where(eq(customers.email, input.customer.email));

      // Insert the booking — the exclusion constraint rejects any (buffered)
      // overlap here, even if checkAvailability raced.
      const [booking] = await tx.insert(bookings).values({
        vehicleId: vehicle.id,
        customerId: customer!.id,
        startAt: input.startAt,
        endAt: input.endAt,
        bufferEndAt,
        status: "pending",
        priceBreakdown: breakdown,
        insuranceTierId: insurance?.id ?? null,
        insuranceSnapshot: insurance,
        paymentOption: input.paymentOption,
        acceptedPolicyVersion: termsVersion,
        acceptedAt: now,
        idempotencyKey: input.idempotencyKey,
      }).returning();

      if (requestedAddOns.length) {
        await tx.insert(bookingAddOns).values(requestedAddOns.map((req) => {
          const line = breakdown.addOns.find((l) => l.id === req.addOnId)!;
          return { bookingId: booking!.id, addOnId: req.addOnId, qty: req.qty, priceSnapshotCents: line.cents };
        }));
      }

      // Encrypt the licence bound to THIS booking id, then store it.
      const enc = encryptLicense(booking!.id, input.license);
      await tx.insert(driverLicenses).values({ bookingId: booking!.id, ...enc, retainUntil });

      return { booking: booking!, breakdown, replayed: false };
    });
  } catch (e) {
    // A same-key race: the other request won — return its booking.
    if (isUniqueViolation(e)) {
      const [winner] = await db.select().from(bookings).where(eq(bookings.idempotencyKey, input.idempotencyKey));
      if (winner) return { booking: winner, breakdown: winner.priceBreakdown as QuoteBreakdown, replayed: true };
    }
    const translated = translateDbError(e);
    if (translated) throw translated; // 23P01 overlap → 409, etc.
    throw e;
  }
}
