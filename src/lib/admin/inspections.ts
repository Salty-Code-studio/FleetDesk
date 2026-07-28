/**
 * Check-in / check-out domain logic (spec W4). The inspection row is the
 * durable record of the handover: photos (storage keys), checklist booleans,
 * odometer/fuel, borg amounts, signature, contract. All writes flow through
 * the audited admin routes; this module owns validation + transactions.
 */
import { z } from "zod";
import { and, eq, lt } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { bookings, vehicles, customers, payments, inspections, driverLicenses } from "@/lib/db/schema";
import { Errors } from "@/lib/http/errors";
import { getLatestPolicy, getPolicyVersion } from "@/lib/admin/policies";
import { getSettings } from "@/lib/admin/settings";
import type { QuoteBreakdown } from "@/lib/booking/quote";
import { assertBookingTransition } from "@/lib/booking/transitions";
import { renderContractPdf } from "@/lib/pdf/contract";
import { putObject, getObject, deleteObject } from "@/lib/storage";
import { bookingPickedUpEmail, bookingReturnSummaryEmail } from "@/lib/email/templates";
import { sendAndLog } from "@/lib/email/send";
import { notifyAdmin } from "@/lib/notify";
import { formatDateTime } from "@/lib/time/format";
import { siteConfig } from "@/lib/site-config";
import { logger } from "@/lib/logger";

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

function assertAnglesPresent(insp: Inspection, what: string): void {
  const labels = new Set(insp.photos.map((p) => p.label));
  const missing = REQUIRED_ANGLES.filter((a) => !labels.has(a));
  if (missing.length > 0) throw Errors.badRequest(`${what} still needed: ${missing.join(", ")}`);
}

/**
 * Finish check-in: guard the inspection completeness inside a transaction,
 * flip the booking to picked_up, then (best-effort, AFTER commit) generate the
 * contract PDF, store it, and email it. A contract hiccup never un-picks-up
 * the car; it is flagged on the bell instead.
 */
export async function completePickup(
  bookingId: string,
  opts: { actorId: string; overrideNote?: string },
): Promise<BookingRow> {
  const db = await getDb();
  const flipped = await db.transaction(async (tx) => {
    const [booking] = await tx.select().from(bookings).where(eq(bookings.id, bookingId)).for("update");
    if (!booking) throw Errors.notFound("Booking not found");
    if (booking.status === "pending" && !opts.overrideNote?.trim()) {
      throw Errors.badRequest("This booking is not paid yet. Add a desk override note to check it out anyway.");
    }
    assertBookingTransition(booking.status, "picked_up");

    const [insp] = await tx.select().from(inspections)
      .where(and(eq(inspections.bookingId, bookingId), eq(inspections.kind, "pickup")));
    if (!insp) throw Errors.badRequest("Start the check-in wizard first");
    assertAnglesPresent(insp, "Walk-around photos");
    if (insp.odometer === null || insp.fuelLevel === null) {
      throw Errors.badRequest("Record the odometer and fuel level first");
    }
    if (!insp.rulesSigned || !insp.agreementSigned || !insp.signatureKey) {
      throw Errors.badRequest("The customer still needs to read the rules and sign");
    }

    const notes = booking.status === "pending" && opts.overrideNote
      ? [booking.notes, `Desk override at check-in: ${opts.overrideNote.trim()}`].filter(Boolean).join("\n")
      : booking.notes;
    const [updated] = await tx.update(bookings)
      .set({ status: "picked_up", notes, updatedAt: new Date() })
      .where(eq(bookings.id, bookingId))
      .returning();
    return { booking: updated!, inspection: insp };
  });

  const [vehicle] = await db.select().from(vehicles).where(eq(vehicles.id, flipped.booking.vehicleId));
  const [customer] = await db.select().from(customers).where(eq(customers.id, flipped.booking.customerId));
  await notifyAdmin({
    level: "success", type: "booking.picked_up", title: "Customer picked up",
    body: `${vehicle?.name ?? "Vehicle"} · ${customer?.email ?? ""}`, bookingId,
  });
  try {
    await finalizePickupArtifacts(flipped.booking, flipped.inspection);
  } catch (e) {
    logger.error("checkin_artifacts_failed", { bookingId, error: (e as Error).message });
    await notifyAdmin({
      level: "warning", type: "booking.picked_up", title: "Contract generation failed",
      body: "Check-in completed but the contract PDF or email failed. Check the server logs.", bookingId,
    });
  }
  return flipped.booking;
}

/** Contract PDF + storage + customer email. Called best-effort after the status flip. */
async function finalizePickupArtifacts(booking: BookingRow, insp: Inspection): Promise<void> {
  const db = await getDb();
  const [vehicle] = await db.select().from(vehicles).where(eq(vehicles.id, booking.vehicleId));
  const [customer] = await db.select().from(customers).where(eq(customers.id, booking.customerId));
  if (!vehicle || !customer) throw new Error("booking context missing");
  const [license] = await db.select().from(driverLicenses).where(eq(driverLicenses.bookingId, booking.id));
  const policy = (insp.acceptedPolicyVersion !== null
    ? await getPolicyVersion("rental_terms", insp.acceptedPolicyVersion)
    : undefined) ?? await getLatestPolicy("rental_terms");

  const breakdown = booking.priceBreakdown as Partial<QuoteBreakdown> & { youngDriverCents?: number };
  const currency = breakdown.currency ?? "USD";
  const subtotal = breakdown.subtotalCents ?? 0;
  const balance = Math.max(0, subtotal - booking.amountPaidCents);

  let signaturePngDataUrl: string | null = null;
  if (insp.signatureKey) {
    try {
      const sig = await getObject(insp.signatureKey);
      signaturePngDataUrl = `data:image/png;base64,${Buffer.from(sig.data).toString("base64")}`;
    } catch (e) {
      logger.warn("checkin_signature_read_failed", { bookingId: booking.id, error: (e as Error).message });
    }
  }

  const pdf = await renderContractPdf({
    operatorName: siteConfig.siteName,
    contractRef: booking.id.slice(0, 8).toUpperCase(),
    generatedAt: formatDateTime(new Date().toISOString()),
    customerName: customer.name ?? license?.nameOnLicense ?? customer.email,
    customerEmail: customer.email,
    customerPhone: customer.phone ?? "",
    driverName: license?.nameOnLicense ?? "On file at the desk",
    licenseCountry: license?.issuingCountry ?? "",
    vehicleName: vehicle.name,
    vehiclePlate: vehicle.plate,
    vehicleClass: vehicle.class,
    periodStart: formatDateTime(booking.startAt),
    periodEnd: formatDateTime(booking.endAt),
    lines: [
      { label: breakdown.days ? `Vehicle (${breakdown.days} days)` : "Vehicle", amount: money(breakdown.vehicleCents ?? subtotal, currency) },
      ...(breakdown.insuranceCents ? [{ label: "Insurance", amount: money(breakdown.insuranceCents, currency) }] : []),
      ...(breakdown.addOns ?? []).map((a) => ({ label: `${a.name} x${a.qty}`, amount: money(a.cents, currency) })),
      ...(breakdown.youngDriverCents ? [{ label: "Young driver fee", amount: money(breakdown.youngDriverCents, currency) }] : []),
    ],
    totalAmount: money(subtotal, currency),
    paidAmount: money(booking.amountPaidCents, currency),
    balanceDue: money(balance, currency),
    borgLine: insp.borgReceivedCents !== null
      ? `${money(insp.borgReceivedCents, currency)} received in ${insp.borgMethod === "card" ? "card" : "cash"} (refundable at return)`
      : "No security deposit collected",
    policyVersion: policy?.version ?? 0,
    policyText: policy?.body ?? "",
    signaturePngDataUrl,
    photoCount: insp.photos.length,
    odometer: insp.odometer === null ? "" : String(insp.odometer),
    fuel: fuelEighthsLabel(insp.fuelLevel),
  });

  const key = `contracts/${booking.id}.pdf`;
  await putObject(key, pdf, "application/pdf");
  await db.update(inspections).set({ contractPdfKey: key }).where(eq(inspections.id, insp.id));

  await sendAndLog({
    to: customer.email,
    type: "booking_picked_up",
    ...bookingPickedUpEmail({
      vehicleName: vehicle.name,
      periodStart: formatDateTime(booking.startAt),
      periodEnd: formatDateTime(booking.endAt),
      balanceDueCents: balance,
      borgReceivedCents: insp.borgReceivedCents,
      currency,
    }),
    attachments: [{ filename: "rental-contract.pdf", content: Buffer.from(pdf).toString("base64") }],
  });
}

/**
 * Finish check-out: guard the return inspection (angles, meters, damage notes,
 * borg math, keys), flip to completed, then bell + summary email. Damage makes
 * the bell a WARNING so the owner sees it without opening anything.
 */
export async function completeReturn(
  bookingId: string,
  opts: { actorId: string },
): Promise<BookingRow> {
  void opts;
  const db = await getDb();
  const done = await db.transaction(async (tx) => {
    const [booking] = await tx.select().from(bookings).where(eq(bookings.id, bookingId)).for("update");
    if (!booking) throw Errors.notFound("Booking not found");
    assertBookingTransition(booking.status, "completed");

    const rows = await tx.select().from(inspections).where(eq(inspections.bookingId, bookingId));
    const pickup = rows.find((i) => i.kind === "pickup") ?? null;
    const ret = rows.find((i) => i.kind === "return");
    if (!ret) throw Errors.badRequest("Start the check-out wizard first");
    assertAnglesPresent(ret, "Return photos");
    if (ret.odometer === null || ret.fuelLevel === null) {
      throw Errors.badRequest("Record the odometer and fuel level first");
    }
    for (const flag of ret.damageFlags) {
      if (!flag.note.trim()) throw Errors.badRequest("Every new damage flag needs a note");
    }
    if (!ret.keysReturned) throw Errors.badRequest("Mark the keys as returned first");

    const received = pickup?.borgReceivedCents ?? null;
    if (received !== null) {
      if (ret.borgReturnedCents === null || ret.borgWithheldCents === null) {
        throw Errors.badRequest("Record the borg decision first: returned in full, partial, or withheld");
      }
      if (ret.borgReturnedCents + ret.borgWithheldCents !== received) {
        throw Errors.badRequest("Borg returned plus withheld must add up to the amount received");
      }
      if (ret.borgWithheldCents > 0 && !ret.borgWithheldReason?.trim()) {
        throw Errors.badRequest("A reason is required when any part of the borg is withheld");
      }
    }

    const [updated] = await tx.update(bookings)
      .set({ status: "completed", updatedAt: new Date() })
      .where(eq(bookings.id, bookingId))
      .returning();
    return { booking: updated!, inspection: ret };
  });

  const damage = done.inspection.damageFlags.length > 0;
  const [vehicle] = await db.select().from(vehicles).where(eq(vehicles.id, done.booking.vehicleId));
  const [customer] = await db.select().from(customers).where(eq(customers.id, done.booking.customerId));
  await notifyAdmin({
    level: damage ? "warning" : "success",
    type: "booking.returned",
    title: damage ? "Car returned with new damage" : "Car returned",
    body: `${vehicle?.name ?? "Vehicle"} · ${customer?.email ?? ""}${damage ? ` · ${done.inspection.damageFlags.length} damage flag(s)` : ""}`,
    bookingId,
  });
  if (customer) {
    const breakdown = done.booking.priceBreakdown as { currency?: string };
    await sendAndLog({
      to: customer.email,
      type: "booking_return_summary",
      ...bookingReturnSummaryEmail({
        vehicleName: vehicle?.name ?? "your rental car",
        returnedAt: formatDateTime(new Date().toISOString()),
        newDamage: damage,
        borgReturnedCents: done.inspection.borgReturnedCents,
        borgWithheldCents: done.inspection.borgWithheldCents,
        borgWithheldReason: done.inspection.borgWithheldReason,
        currency: breakdown.currency ?? "USD",
      }),
    });
  }
  return done.booking;
}

/**
 * Retention sweep (spec open-detail A: follow the licenseRetentionDays
 * pattern). Once a completed rental is older than the retention window, the
 * PII-bearing media (walk-around photos, licence photo, signature) is deleted
 * from storage and the keys blanked. Damage NOTES stay (business record, no
 * PII), and the CONTRACT PDF stays (the signed agreement is the proof the
 * versioned-policies system exists for). Runs from the daily cron.
 */
export async function sweepInspectionMedia(now = new Date()): Promise<number> {
  const db = await getDb();
  const settings = await getSettings();
  const cutoff = new Date(now.getTime() - settings.licenseRetentionDays * 86_400_000);

  const rows = await db.select({ insp: inspections })
    .from(inspections)
    .innerJoin(bookings, eq(inspections.bookingId, bookings.id))
    // bookings.endAt is a `mode: "string"` timestamptz column, so compare
    // against an ISO string like every other endAt comparison in this codebase.
    .where(and(eq(bookings.status, "completed"), lt(bookings.endAt, cutoff.toISOString())));

  let purged = 0;
  for (const { insp } of rows) {
    const keys = [
      ...insp.photos.map((p) => p.key),
      insp.licensePhotoKey,
      insp.signatureKey,
    ].filter((k): k is string => !!k);
    if (keys.length === 0) continue; // already purged — idempotent

    for (const key of keys) {
      await deleteObject(key).catch((e) =>
        logger.warn("inspection_media_delete_failed", { key, error: (e as Error).message }),
      );
    }
    await db.update(inspections).set({
      photos: [],
      licensePhotoKey: null,
      signatureKey: null,
      damageFlags: insp.damageFlags.map((f) => ({ photoKey: "", note: f.note })),
    }).where(eq(inspections.id, insp.id));
    purged++;
  }
  return purged;
}
