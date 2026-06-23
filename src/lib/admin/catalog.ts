import { z } from "zod";
import { eq, ne, asc } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { addOns, insuranceTiers } from "@/lib/db/schema";
import { centsField } from "@/lib/admin/money";
import { Errors } from "@/lib/http/errors";

export type AddOn = typeof addOns.$inferSelect;
export type InsuranceTier = typeof insuranceTiers.$inferSelect;

// ---- Add-ons ----
export const AddOnCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).default(""),
  priceCents: centsField,
  pricing: z.enum(["per_day", "per_rental"]).default("per_rental"),
  category: z.string().trim().max(40).default("equipment"),
  stock: z.number().int().min(0).max(1000).nullable().default(null),
  active: z.boolean().default(true),
}).strict();
export const AddOnPatchSchema = AddOnCreateSchema.partial().strict()
  .refine((v) => Object.keys(v).length > 0, { message: "No fields to update" });

export async function listAddOns(): Promise<AddOn[]> {
  const db = await getDb();
  return db.select().from(addOns).orderBy(asc(addOns.category), asc(addOns.name));
}
export async function createAddOn(input: z.infer<typeof AddOnCreateSchema>): Promise<AddOn> {
  const db = await getDb();
  const [row] = await db.insert(addOns).values(input).returning();
  return row!;
}
export async function updateAddOn(id: string, patch: z.infer<typeof AddOnPatchSchema>): Promise<AddOn> {
  const db = await getDb();
  const [row] = await db.update(addOns).set(patch).where(eq(addOns.id, id)).returning();
  if (!row) throw Errors.notFound("Add-on not found");
  return row;
}
export async function deleteAddOn(id: string): Promise<boolean> {
  const db = await getDb();
  const deleted = await db.delete(addOns).where(eq(addOns.id, id)).returning({ id: addOns.id });
  return deleted.length > 0;
}

// ---- Insurance tiers ----
export const InsuranceCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  dailyPriceCents: centsField.default(0),
  coverage: z.string().trim().max(500).default(""),
  isDefault: z.boolean().default(false),
  active: z.boolean().default(true),
}).strict();
export const InsurancePatchSchema = InsuranceCreateSchema.partial().strict()
  .refine((v) => Object.keys(v).length > 0, { message: "No fields to update" });

export async function listInsurance(): Promise<InsuranceTier[]> {
  const db = await getDb();
  return db.select().from(insuranceTiers).orderBy(asc(insuranceTiers.dailyPriceCents));
}

/** Enforce at most ONE default tier: setting one default clears the others. */
async function clearOtherDefaults(exceptId: string | null): Promise<void> {
  const db = await getDb();
  if (exceptId) {
    await db.update(insuranceTiers).set({ isDefault: false }).where(ne(insuranceTiers.id, exceptId));
  } else {
    await db.update(insuranceTiers).set({ isDefault: false });
  }
}

export async function createInsurance(input: z.infer<typeof InsuranceCreateSchema>): Promise<InsuranceTier> {
  const db = await getDb();
  const [row] = await db.insert(insuranceTiers).values(input).returning();
  if (row!.isDefault) await clearOtherDefaults(row!.id);
  return row!;
}
export async function updateInsurance(id: string, patch: z.infer<typeof InsurancePatchSchema>): Promise<InsuranceTier> {
  const db = await getDb();
  const [row] = await db.update(insuranceTiers).set(patch).where(eq(insuranceTiers.id, id)).returning();
  if (!row) throw Errors.notFound("Insurance tier not found");
  if (patch.isDefault === true) await clearOtherDefaults(id);
  return row;
}
export async function deleteInsurance(id: string): Promise<boolean> {
  const db = await getDb();
  const deleted = await db.delete(insuranceTiers).where(eq(insuranceTiers.id, id)).returning({ id: insuranceTiers.id });
  return deleted.length > 0;
}
