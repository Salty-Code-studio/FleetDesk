import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { vehicles, customers, bookings } from "@/lib/db/schema";
import { Errors } from "@/lib/http/errors";
import { translateDbError } from "@/lib/db/errors";
import { getSettings } from "@/lib/admin/settings";
import { addHoursIso, parseTs } from "@/lib/time/format";
import { isoDateTime } from "@/lib/validation/iso-date";

/**
 * Walk-in / phone bookings made at the desk. These skip the public booking
 * funnel entirely: no online payment, no policy-acceptance gate, no soft date
 * guardrails (lead time, max advance, min/max length). The ONE thing they can
 * never skip is the physical no-overlap-plus-buffer exclusion constraint — a
 * manual booking that collides with an existing reservation is rejected at the
 * database level just like an online one.
 */
export const ManualBookingSchema = z.object({
  vehicleId: z.string().uuid(),
  startAt: isoDateTime,
  endAt: isoDateTime,
  customerName: z.string().trim().min(1).max(120),
  customerPhone: z.string().trim().max(40).default(""),
  customerEmail: z.string().trim().toLowerCase().email().max(254).optional(),
  priceCents: z.number().int().min(0).max(100_000_00).optional(),
  notes: z.string().trim().max(500).optional(),
}).strict().refine((v) => parseTs(v.endAt) > parseTs(v.startAt), { message: "endAt must be after startAt", path: ["endAt"] });

export type ManualBookingInput = z.input<typeof ManualBookingSchema>;

/**
 * Walk-ins rarely give an email. We still need a unique customer row, so mint a
 * synthetic local address. The random suffix means two walk-ins with the same
 * name/phone never collide on the customers.email unique index.
 */
function syntheticEmail(phone: string, name: string): string {
  const slug = (phone || name).replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 20) || "walkin";
  const rand = Math.random().toString(36).slice(2, 8);
  return `walkin+${slug}-${Date.now().toString(36)}${rand}@fleetdesk.local`;
}

export async function createManualBooking(raw: ManualBookingInput) {
  const input = ManualBookingSchema.parse(raw); // apply defaults (phone → "") even on direct calls
  const db = await getDb();
  const settings = await getSettings();
  const [vehicle] = await db.select().from(vehicles).where(eq(vehicles.id, input.vehicleId));
  if (!vehicle || vehicle.status === "retired") throw Errors.notFound("Vehicle not available");

  const email = input.customerEmail ?? syntheticEmail(input.customerPhone, input.customerName);
  await db.insert(customers)
    .values({ email, name: input.customerName, phone: input.customerPhone })
    .onConflictDoNothing({ target: customers.email });
  const [customer] = await db.select().from(customers).where(eq(customers.email, email));

  const bufferEndAt = addHoursIso(input.endAt, settings.turnaroundBufferHours);
  const breakdown = { manual: true, subtotalCents: input.priceCents ?? 0, currency: settings.currency };

  try {
    const [booking] = await db.insert(bookings).values({
      vehicleId: vehicle.id, customerId: customer!.id,
      startAt: input.startAt, endAt: input.endAt, bufferEndAt,
      status: "confirmed", source: "manual", notes: input.notes ?? null,
      priceBreakdown: breakdown, paymentOption: "cash_deposit",
      acceptedPolicyVersion: 0, acceptedAt: new Date(),
      idempotencyKey: `manual-${customer!.id}-${input.startAt}-${input.endAt}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    }).returning();
    return booking!;
  } catch (e) {
    const t = translateDbError(e); // 23P01 overlap+buffer → 409
    if (t) throw t;
    throw e;
  }
}
