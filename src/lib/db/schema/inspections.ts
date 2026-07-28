import { pgTable, pgEnum, text, integer, smallint, boolean, timestamp, uuid, jsonb, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { bookings } from "./bookings";
import { adminUsers } from "./admin";

export const inspectionKind = pgEnum("inspection_kind", ["pickup", "return"]);

export interface InspectionPhoto { key: string; label: string }
export interface DamageFlag { photoKey: string; note: string }

/**
 * One row per booking per kind (pickup | return) — the check-in/check-out
 * record (spec W4). Photos/licence/signature are STORAGE KEYS into the private
 * object store, never URLs. Checklist booleans render as single-tap toggles in
 * the BookingDrawer; borg (security deposit) amounts feed the reports
 * workstream. fuelLevel is eighths of a tank: 0 = empty .. 8 = full.
 */
export const inspections = pgTable("inspections", {
  id: uuid("id").defaultRandom().primaryKey(),
  bookingId: uuid("booking_id").notNull().references(() => bookings.id, { onDelete: "cascade" }),
  kind: inspectionKind("kind").notNull(),
  odometer: integer("odometer"),
  fuelLevel: smallint("fuel_level"),
  notes: text("notes").notNull().default(""),
  photos: jsonb("photos").$type<InspectionPhoto[]>().notNull().default(sql`'[]'::jsonb`),
  licensePhotoKey: text("license_photo_key"),
  signatureKey: text("signature_key"),
  contractPdfKey: text("contract_pdf_key"),
  damageFlags: jsonb("damage_flags").$type<DamageFlag[]>().notNull().default(sql`'[]'::jsonb`),
  acceptedPolicyVersion: integer("accepted_policy_version"),
  agreementSigned: boolean("agreement_signed").notNull().default(false),
  rulesSigned: boolean("rules_signed").notNull().default(false),
  licenseCopyReceived: boolean("license_copy_received").notNull().default(false),
  borgReceivedCents: integer("borg_received_cents"),
  borgMethod: text("borg_method"), // 'cash' | 'card' (validated by zod at the boundary)
  borgReturnedCents: integer("borg_returned_cents"),
  borgWithheldCents: integer("borg_withheld_cents"),
  borgWithheldReason: text("borg_withheld_reason"),
  keysReturned: boolean("keys_returned").notNull().default(false),
  createdBy: uuid("created_by").notNull().references(() => adminUsers.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("inspections_booking_kind").on(t.bookingId, t.kind),
  check("inspections_fuel_level", sql`${t.fuelLevel} IS NULL OR (${t.fuelLevel} >= 0 AND ${t.fuelLevel} <= 8)`),
]);
