/**
 * Check-in / check-out domain logic (spec W4). The inspection row is the
 * durable record of the handover: photos (storage keys), checklist booleans,
 * odometer/fuel, borg amounts, signature, contract. All writes flow through
 * the audited admin routes; this module owns validation + transactions.
 */
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { bookings, vehicles, customers, payments, inspections, driverLicenses } from "@/lib/db/schema";
import { Errors } from "@/lib/http/errors";
import { getLatestPolicy } from "@/lib/admin/policies";
import type { QuoteBreakdown } from "@/lib/booking/quote";

export type Inspection = typeof inspections.$inferSelect;
export type BookingRow = typeof bookings.$inferSelect;

export const REQUIRED_ANGLES = ["front", "back", "left", "right", "interior", "dash"] as const;

const FUEL_EIGHTHS = ["Empty", "1/8", "1/4", "3/8", "1/2", "5/8", "3/4", "7/8", "Full"];
export function fuelEighthsLabel(v: number | null): string {
  return v === null ? "" : FUEL_EIGHTHS[v] ?? String(v);
}

export const money = (cents: number, currency: string) => `${currency} ${(cents / 100).toFixed(2)}`;

const storageKey = z.string().min(1).max(300);

export const InspectionPatchSchema = z.object({
  odometer: z.number().int().min(0).max(2_000_000).optional(),
  fuelLevel: z.number().int().min(0).max(8).optional(),
  notes: z.string().trim().max(4000).optional(),
  photos: z.array(z.object({ key: storageKey, label: z.string().trim().min(1).max(120) }).strict()).max(40).optional(),
  licensePhotoKey: storageKey.nullable().optional(),
  signatureKey: storageKey.nullable().optional(),
  damageFlags: z.array(z.object({ photoKey: z.string().max(300), note: z.string().trim().min(1).max(500) }).strict()).max(40).optional(),
  acceptedPolicyVersion: z.number().int().min(0).optional(),
  agreementSigned: z.boolean().optional(),
  rulesSigned: z.boolean().optional(),
  licenseCopyReceived: z.boolean().optional(),
  borgReceivedCents: z.number().int().min(0).max(10_000_000).nullable().optional(),
  borgMethod: z.enum(["cash", "card"]).nullable().optional(),
  borgReturnedCents: z.number().int().min(0).max(10_000_000).nullable().optional(),
  borgWithheldCents: z.number().int().min(0).max(10_000_000).nullable().optional(),
  borgWithheldReason: z.string().trim().max(500).nullable().optional(),
  keysReturned: z.boolean().optional(),
}).strict();

export type InspectionPatch = z.infer<typeof InspectionPatchSchema>;

/** Create-or-update the draft inspection for (booking, kind). Returns before/after for the audit log. */
export async function upsertInspection(
  bookingId: string,
  kind: "pickup" | "return",
  patch: InspectionPatch,
  actorId: string,
): Promise<{ before: Inspection | null; after: Inspection }> {
  const db = await getDb();
  const [booking] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
  if (!booking) throw Errors.notFound("Booking not found");
  if (booking.status === "cancelled") throw Errors.conflict("A cancelled booking cannot be inspected");
  if (kind === "return" && booking.status !== "picked_up" && booking.status !== "completed") {
    throw Errors.conflict("Check the car in before starting a return inspection");
  }

  await db.insert(inspections)
    .values({ bookingId, kind, createdBy: actorId })
    .onConflictDoNothing({ target: [inspections.bookingId, inspections.kind] });
  const [before] = await db.select().from(inspections)
    .where(and(eq(inspections.bookingId, bookingId), eq(inspections.kind, kind)));
  if (!before) throw Errors.notFound("Inspection row missing"); // unreachable after the insert above

  if (Object.keys(patch).length === 0) return { before, after: before };
  const [after] = await db.update(inspections)
    .set(patch)
    .where(eq(inspections.id, before.id))
    .returning();
  return { before, after: after! };
}

/**
 * The check-in "balance collected at desk" action: one succeeded desk payment
 * row (type 'balance', method 'desk') plus the amountPaidCents bump, atomically.
 */
export async function recordDeskBalancePayment(
  bookingId: string,
  amountCents: number,
  actorId: string,
): Promise<BookingRow> {
  void actorId; // actor lands in the audit log via mutate(); kept in the signature for symmetry
  const db = await getDb();
  return db.transaction(async (tx) => {
    const [booking] = await tx.select().from(bookings).where(eq(bookings.id, bookingId)).for("update");
    if (!booking) throw Errors.notFound("Booking not found");
    if (booking.status === "cancelled" || booking.status === "completed") {
      throw Errors.conflict("This booking can no longer take payments");
    }
    const breakdown = booking.priceBreakdown as Partial<QuoteBreakdown>;
    const balance = Math.max(0, (breakdown.subtotalCents ?? 0) - booking.amountPaidCents);
    if (amountCents <= 0) throw Errors.badRequest("Amount must be positive");
    if (amountCents > balance) throw Errors.badRequest("That is more than the open balance");
    await tx.insert(payments).values({
      bookingId, type: "balance", method: "desk", amountCents,
      currency: breakdown.currency ?? "USD", status: "succeeded",
    });
    const [updated] = await tx.update(bookings)
      .set({ amountPaidCents: booking.amountPaidCents + amountCents, updatedAt: new Date() })
      .where(eq(bookings.id, bookingId))
      .returning();
    return updated!;
  });
}

export interface HandoverPriceLine { label: string; cents: number }

export interface HandoverPayload {
  booking: {
    id: string; status: string; source: string; notes: string | null;
    startAt: string; endAt: string; currency: string;
    subtotalCents: number; amountPaidCents: number; balanceDueCents: number;
    priceLines: HandoverPriceLine[];
  };
  vehicle: { id: string; name: string; plate: string; class: string; depositCents: number | null };
  customer: { name: string | null; email: string; phone: string | null };
  license: { nameOnLicense: string; issuingCountry: string; expiryDate: string } | null;
  policy: { version: number; body: string } | null;
  inspections: { pickup: Inspection | null; return: Inspection | null };
}

/** Everything both wizards and the drawer panel need, in ONE read (less clicking). */
export async function getHandover(bookingId: string): Promise<HandoverPayload> {
  const db = await getDb();
  const [row] = await db.select({ booking: bookings, vehicle: vehicles, customer: customers })
    .from(bookings)
    .innerJoin(vehicles, eq(bookings.vehicleId, vehicles.id))
    .innerJoin(customers, eq(bookings.customerId, customers.id))
    .where(eq(bookings.id, bookingId));
  if (!row) throw Errors.notFound("Booking not found");
  const b = row.booking;

  const [license] = await db.select({
    nameOnLicense: driverLicenses.nameOnLicense,
    issuingCountry: driverLicenses.issuingCountry,
    expiryDate: driverLicenses.expiryDate,
  }).from(driverLicenses).where(eq(driverLicenses.bookingId, bookingId));

  const policy = await getLatestPolicy("rental_terms");
  const insp = await db.select().from(inspections).where(eq(inspections.bookingId, bookingId));

  const breakdown = b.priceBreakdown as Partial<QuoteBreakdown> & { youngDriverCents?: number };
  const subtotal = breakdown.subtotalCents ?? 0;
  const priceLines: HandoverPriceLine[] = [
    {
      label: breakdown.days ? `Vehicle (${breakdown.days} day${breakdown.days === 1 ? "" : "s"})` : "Vehicle",
      cents: breakdown.vehicleCents ?? subtotal,
    },
    ...(breakdown.insuranceCents ? [{ label: "Insurance", cents: breakdown.insuranceCents }] : []),
    ...(breakdown.addOns ?? []).map((a) => ({ label: `${a.name} x${a.qty}`, cents: a.cents })),
    ...(breakdown.youngDriverCents ? [{ label: "Young driver fee", cents: breakdown.youngDriverCents }] : []),
  ];

  return {
    booking: {
      id: b.id, status: b.status, source: b.source, notes: b.notes,
      // startAt/endAt are `mode: "string"` timestamptz columns — already ISO
      // strings; pass them straight through like the ops board (planning.ts) does.
      startAt: b.startAt, endAt: b.endAt,
      currency: breakdown.currency ?? "USD",
      subtotalCents: subtotal,
      amountPaidCents: b.amountPaidCents,
      balanceDueCents: Math.max(0, subtotal - b.amountPaidCents),
      priceLines,
    },
    vehicle: {
      id: row.vehicle.id, name: row.vehicle.name, plate: row.vehicle.plate,
      class: row.vehicle.class, depositCents: row.vehicle.depositCents,
    },
    customer: { name: row.customer.name, email: row.customer.email, phone: row.customer.phone },
    license: license ?? null,
    policy: policy ? { version: policy.version, body: policy.body } : null,
    inspections: {
      pickup: insp.find((i) => i.kind === "pickup") ?? null,
      return: insp.find((i) => i.kind === "return") ?? null,
    },
  };
}
