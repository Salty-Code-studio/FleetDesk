import { z } from "zod";
import { desc, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { vehicleNotes } from "@/lib/db/schema";
import { getVehicle } from "@/lib/admin/vehicles";
import { Errors } from "@/lib/http/errors";

export type VehicleNote = typeof vehicleNotes.$inferSelect;

export const NoteCreateSchema = z.object({
  body: z.string().trim().min(1, "Write something first").max(500),
}).strict();

export const NotePatchSchema = z.object({ resolved: z.boolean() }).strict();

export async function createNote(
  vehicleId: string,
  raw: z.input<typeof NoteCreateSchema>,
  createdBy: string | null,
): Promise<VehicleNote> {
  const input = NoteCreateSchema.parse(raw);
  const db = await getDb();
  const vehicle = await getVehicle(vehicleId);
  if (!vehicle) throw Errors.notFound("Vehicle not found");
  const [row] = await db.insert(vehicleNotes).values({ vehicleId, body: input.body, createdBy }).returning();
  return row!;
}

export async function listNotes(vehicleId: string): Promise<VehicleNote[]> {
  const db = await getDb();
  return db.select().from(vehicleNotes)
    .where(eq(vehicleNotes.vehicleId, vehicleId))
    .orderBy(desc(vehicleNotes.createdAt), desc(vehicleNotes.id));
}

export async function getNote(id: string): Promise<VehicleNote | undefined> {
  const db = await getDb();
  const [row] = await db.select().from(vehicleNotes).where(eq(vehicleNotes.id, id));
  return row;
}

export async function setNoteResolved(id: string, resolved: boolean): Promise<VehicleNote> {
  const db = await getDb();
  const [row] = await db.update(vehicleNotes)
    .set({ resolvedAt: resolved ? new Date() : null })
    .where(eq(vehicleNotes.id, id))
    .returning();
  if (!row) throw Errors.notFound("Note not found");
  return row;
}

/** Open-note counts per vehicle in one grouped query (badges on fleet + planning). */
export async function openNoteCounts(): Promise<Map<string, number>> {
  const db = await getDb();
  const rows = await db.select({
    vehicleId: vehicleNotes.vehicleId,
    n: sql<number>`count(*)::int`,
  }).from(vehicleNotes).where(isNull(vehicleNotes.resolvedAt)).groupBy(vehicleNotes.vehicleId);
  return new Map(rows.map((r) => [r.vehicleId, r.n]));
}
