import { z } from "zod";
import { eq, asc } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { vehicles, availabilityBlocks } from "@/lib/db/schema";
import { centsField, optionalCentsField } from "@/lib/admin/money";
import { Errors } from "@/lib/http/errors";
import { isoDate } from "@/lib/validation/iso-date";

export type Vehicle = typeof vehicles.$inferSelect;
export type AvailabilityBlock = typeof availabilityBlocks.$inferSelect;

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
  startDate: isoDate,
  endDate: isoDate,
  type: z.enum(["maintenance", "carwash", "cleaning", "out_of_service", "other"]).default("other"),
  reason: z.string().trim().max(200).default(""),
}).strict().refine((v) => v.endDate > v.startDate, { message: "endDate must be after startDate", path: ["endDate"] });

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

export async function listBlocks(vehicleId: string): Promise<AvailabilityBlock[]> {
  const db = await getDb();
  return db.select().from(availabilityBlocks).where(eq(availabilityBlocks.vehicleId, vehicleId)).orderBy(asc(availabilityBlocks.startDate));
}

export async function createBlock(vehicleId: string, raw: z.input<typeof BlockSchema>): Promise<AvailabilityBlock> {
  const input = BlockSchema.parse(raw); // apply defaults (type → "other", reason → "") on direct calls
  const db = await getDb();
  const vehicle = await getVehicle(vehicleId);
  if (!vehicle) throw Errors.notFound("Vehicle not found");
  const [row] = await db.insert(availabilityBlocks).values({ vehicleId, ...input }).returning();
  return row!;
}

export async function deleteBlock(id: string): Promise<boolean> {
  const db = await getDb();
  const deleted = await db.delete(availabilityBlocks).where(eq(availabilityBlocks.id, id)).returning({ id: availabilityBlocks.id });
  return deleted.length > 0;
}
