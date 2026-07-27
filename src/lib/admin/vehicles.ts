import { z } from "zod";
import { eq, asc } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { vehicles, availabilityBlocks } from "@/lib/db/schema";
import { centsField, optionalCentsField } from "@/lib/admin/money";
import { Errors } from "@/lib/http/errors";
import { isoDateTime } from "@/lib/validation/iso-date";
import { arubaDateOf, parseTs } from "@/lib/time/format";

export type Vehicle = typeof vehicles.$inferSelect;
/** Blocks are whole out-of-service days; the day fields are derived from the
 *  underlying midnight-to-midnight Aruba timestamps stored on the row. */
export type AvailabilityBlock = Omit<typeof availabilityBlocks.$inferSelect, "startAt" | "endAt"> & {
  startDate: string;
  endDate: string;
};

export const VehicleCreateSchema = z.object({
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be kebab-case").max(80),
  plate: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9 -]{0,11}$/, "letters, numbers, spaces or dashes").max(12),
  class: z.enum(["Economy", "Compact", "SUV", "4x4", "Van"]),
  name: z.string().trim().min(1).max(120),
  seats: z.number().int().min(1).max(20),
  transmission: z.enum(["Automatic", "Manual"]),
  ac: z.boolean().default(true),
  doors: z.number().int().min(1).max(8),
  photos: z.array(z.string().url().or(z.string().regex(/^\/?[\w./-]+$/))).max(12).default([]),
  priceDayCents: centsField,
  priceWeekCents: centsField,
  priceMonthCents: centsField,
  depositCents: optionalCentsField,
  status: z.enum(["active", "maintenance", "retired"]).default("active"),
}).strict();

export const VehiclePatchSchema = VehicleCreateSchema.partial().strict();

export const BlockSchema = z.object({
  startAt: isoDateTime,
  endAt: isoDateTime,
  type: z.enum(["maintenance", "carwash", "cleaning", "out_of_service", "other"]).default("other"),
  reason: z.string().trim().max(200).default(""),
}).strict().refine((v) => parseTs(v.endAt) > parseTs(v.startAt), { message: "endAt must be after startAt", path: ["endAt"] });

export async function listVehicles(): Promise<Vehicle[]> {
  const db = await getDb();
  return db.select().from(vehicles).orderBy(asc(vehicles.class), asc(vehicles.name));
}

export async function getVehicle(id: string): Promise<Vehicle | undefined> {
  const db = await getDb();
  const [row] = await db.select().from(vehicles).where(eq(vehicles.id, id));
  return row;
}

export async function createVehicle(input: z.infer<typeof VehicleCreateSchema>): Promise<Vehicle> {
  const db = await getDb();
  const existing = await db.select({ id: vehicles.id }).from(vehicles).where(eq(vehicles.slug, input.slug));
  if (existing.length > 0) throw Errors.conflict("A vehicle with that slug already exists");
  const [row] = await db.insert(vehicles).values(input).returning();
  return row!;
}

export async function updateVehicle(id: string, patch: z.infer<typeof VehiclePatchSchema>): Promise<Vehicle> {
  const db = await getDb();
  const current = await getVehicle(id);
  if (!current) throw Errors.notFound("Vehicle not found");
  if (patch.slug && patch.slug !== current.slug) {
    const clash = await db.select({ id: vehicles.id }).from(vehicles).where(eq(vehicles.slug, patch.slug));
    if (clash.length > 0) throw Errors.conflict("A vehicle with that slug already exists");
  }
  const [row] = await db.update(vehicles).set({ ...patch, updatedAt: new Date() }).where(eq(vehicles.id, id)).returning();
  return row!;
}

/**
 * Take a vehicle out of service. We RETIRE (status='retired') rather than hard
 * delete: a vehicle is referenced by historical bookings, and retiring keeps
 * that trail intact while removing it from public listings and the booking flow.
 */
export async function retireVehicle(id: string): Promise<Vehicle> {
  const db = await getDb();
  const current = await getVehicle(id);
  if (!current) throw Errors.notFound("Vehicle not found");
  const [row] = await db.update(vehicles).set({ status: "retired", updatedAt: new Date() }).where(eq(vehicles.id, id)).returning();
  return row!;
}

function toBlockView(row: typeof availabilityBlocks.$inferSelect): AvailabilityBlock {
  const { startAt, endAt, ...rest } = row;
  return { ...rest, startDate: arubaDateOf(startAt), endDate: arubaDateOf(endAt) };
}

export async function listBlocks(vehicleId: string): Promise<AvailabilityBlock[]> {
  const db = await getDb();
  const rows = await db.select().from(availabilityBlocks).where(eq(availabilityBlocks.vehicleId, vehicleId)).orderBy(asc(availabilityBlocks.startAt));
  return rows.map(toBlockView);
}

export async function createBlock(vehicleId: string, raw: z.input<typeof BlockSchema>): Promise<AvailabilityBlock> {
  const input = BlockSchema.parse(raw); // apply defaults (type → "other", reason → "") on direct calls
  const db = await getDb();
  const vehicle = await getVehicle(vehicleId);
  if (!vehicle) throw Errors.notFound("Vehicle not found");
  // Blocks carry full Aruba timestamps. A full-day block is midnight-to-midnight
  // (00:00 to 00:00 the next day); timed blocks (e.g. a mid-day carwash) narrow
  // the window. The exclusion constraint guards against overlaps either way.
  const [row] = await db.insert(availabilityBlocks).values({
    vehicleId,
    startAt: input.startAt,
    endAt: input.endAt,
    type: input.type,
    reason: input.reason,
  }).returning();
  return toBlockView(row!);
}

export async function deleteBlock(id: string): Promise<boolean> {
  const db = await getDb();
  const deleted = await db.delete(availabilityBlocks).where(eq(availabilityBlocks.id, id)).returning({ id: availabilityBlocks.id });
  return deleted.length > 0;
}
