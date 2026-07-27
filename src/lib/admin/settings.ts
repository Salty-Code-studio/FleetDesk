import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { settings, blackoutDates } from "@/lib/db/schema";
import { centsField } from "@/lib/admin/money";
import { Errors } from "@/lib/http/errors";
import { isoDate } from "@/lib/validation/iso-date";

export type Settings = typeof settings.$inferSelect;
export type BlackoutDate = typeof blackoutDates.$inferSelect;

const TIME_HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Partial update — every field optional, each independently range-checked. */
export const SettingsPatchSchema = z.object({
  reservationFeeCents: centsField.optional(),
  currency: z.string().trim().toUpperCase().length(3, "3-letter currency code").optional(),
  minDriverAge: z.number().int().min(16).max(99).optional(),
  turnaroundBufferHours: z.number().int().min(0).max(168).optional(),
  openingTime: z.string().regex(TIME_HHMM, "must be HH:MM").optional(),
  closingTime: z.string().regex(TIME_HHMM, "must be HH:MM").optional(),
  minRentalDays: z.number().int().min(1).max(365).optional(),
  maxRentalDays: z.number().int().min(1).max(365).optional(),
  maxAdvanceDays: z.number().int().min(1).max(1095).optional(),
  licenseRetentionDays: z.number().int().min(1).max(3650).optional(),
  adminAlertRecipients: z.array(z.string().trim().toLowerCase().email()).max(20).optional(),
}).strict().refine(
  (v) => v.minRentalDays === undefined || v.maxRentalDays === undefined || v.minRentalDays <= v.maxRentalDays,
  { message: "minRentalDays must be ≤ maxRentalDays", path: ["minRentalDays"] },
).refine(
  (v) => v.openingTime === undefined || v.closingTime === undefined || v.openingTime < v.closingTime,
  { message: "openingTime must be before closingTime", path: ["openingTime"] },
);

export const BlackoutSchema = z.object({
  startDate: isoDate,
  endDate: isoDate,
  reason: z.string().trim().max(200).default(""),
}).strict().refine((v) => v.endDate > v.startDate, {
  message: "endDate must be after startDate", path: ["endDate"],
});

export async function getSettings(): Promise<Settings> {
  const db = await getDb();
  const [row] = await db.select().from(settings).where(eq(settings.id, 1));
  if (row) return row;
  // Self-heal if the seed never ran: create the singleton with defaults.
  const [created] = await db.insert(settings).values({ id: 1 }).onConflictDoNothing().returning();
  if (created) return created;
  const [existing] = await db.select().from(settings).where(eq(settings.id, 1));
  return existing!;
}

export async function patchSettings(patch: z.infer<typeof SettingsPatchSchema>): Promise<Settings> {
  const db = await getDb();
  const current = await getSettings(); // ensure the row exists
  // The schema only catches min>max when BOTH are in the patch. Re-check the
  // MERGED result so a partial PATCH can't persist an inconsistent range that
  // the Plan 04 booking-length guardrail would later read.
  const mergedMin = patch.minRentalDays ?? current.minRentalDays;
  const mergedMax = patch.maxRentalDays ?? current.maxRentalDays;
  if (mergedMin > mergedMax) {
    throw Errors.validation([{ path: "minRentalDays", message: "minRentalDays must be ≤ maxRentalDays" }]);
  }
  const mergedOpening = patch.openingTime ?? current.openingTime;
  const mergedClosing = patch.closingTime ?? current.closingTime;
  if (mergedOpening >= mergedClosing) {
    throw Errors.validation([{ path: "openingTime", message: "openingTime must be before closingTime" }]);
  }
  const [updated] = await db.update(settings)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(settings.id, 1))
    .returning();
  return updated!;
}

export async function listBlackouts(): Promise<BlackoutDate[]> {
  const db = await getDb();
  return db.select().from(blackoutDates).orderBy(blackoutDates.startDate);
}

export async function createBlackout(input: z.infer<typeof BlackoutSchema>): Promise<BlackoutDate> {
  const db = await getDb();
  const [row] = await db.insert(blackoutDates).values(input).returning();
  return row!;
}

export async function deleteBlackout(id: string): Promise<boolean> {
  const db = await getDb();
  const deleted = await db.delete(blackoutDates).where(eq(blackoutDates.id, id)).returning({ id: blackoutDates.id });
  return deleted.length > 0;
}
