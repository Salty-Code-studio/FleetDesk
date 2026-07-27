import { pgTable, pgEnum, text, integer, timestamp, uuid, jsonb, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { vehicles } from "./fleet";
import { customers } from "./customers";
import { addOns, insuranceTiers } from "./catalog";

export const bookingStatus = pgEnum("booking_status", ["pending", "confirmed", "picked_up", "cancelled", "completed"]);
export const paymentOption = pgEnum("payment_option", ["deposit", "full"]);
export const bookingSource = pgEnum("booking_source", ["online", "manual"]);

/**
 * Time semantics: [startAt, endAt) timestamptz (Aruba wall time) — endAt is the
 * return instant, exclusive, so back-to-back rentals share a boundary without
 * colliding.
 *
 * Overlap safety is NOT app code: a custom migration adds
 *   EXCLUDE USING gist (vehicle_id WITH =, tstzrange(start_at, buffer_end_at, '[)') WITH &&)
 *   WHERE (status IN ('pending', 'confirmed', 'picked_up'))
 * making double-booking physically impossible even under a race (spec §7).
 * bufferEndAt = endAt + the turnaround buffer hours at booking time, so the
 * cleaning gap is enforced by the DATABASE, not just the advisory pre-check.
 */
export const bookings = pgTable("bookings", {
  id: uuid("id").defaultRandom().primaryKey(),
  vehicleId: uuid("vehicle_id").notNull().references(() => vehicles.id),
  customerId: uuid("customer_id").notNull().references(() => customers.id),
  startAt: timestamp("start_at", { withTimezone: true, mode: "string" }).notNull(),
  endAt: timestamp("end_at", { withTimezone: true, mode: "string" }).notNull(),
  bufferEndAt: timestamp("buffer_end_at", { withTimezone: true, mode: "string" }).notNull(), // endAt + turnaround buffer hours; drives the exclusion constraint
  status: bookingStatus("status").notNull().default("pending"),
  source: bookingSource("source").notNull().default("online"),
  notes: text("notes"), // free-text, e.g. for manual desk bookings
  priceBreakdown: jsonb("price_breakdown").notNull(), // server-computed snapshot, never client math
  insuranceTierId: uuid("insurance_tier_id").references(() => insuranceTiers.id),
  insuranceSnapshot: jsonb("insurance_snapshot"),
  paymentOption: paymentOption("payment_option").notNull(),
  // Sum of settled money on this booking. Credited by the Stripe webhook and by
  // desk payments, debited by refunds, so balance-due is queryable.
  amountPaidCents: integer("amount_paid_cents").notNull().default(0),
  acceptedPolicyVersion: integer("accepted_policy_version").notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("bookings_dates", sql`${t.endAt} > ${t.startAt}`),
  check("bookings_buffer", sql`${t.bufferEndAt} >= ${t.endAt}`),
]);

export const bookingAddOns = pgTable("booking_add_ons", {
  id: uuid("id").defaultRandom().primaryKey(),
  bookingId: uuid("booking_id").notNull().references(() => bookings.id, { onDelete: "cascade" }),
  addOnId: uuid("add_on_id").notNull().references(() => addOns.id),
  qty: integer("qty").notNull().default(1),
  priceSnapshotCents: integer("price_snapshot_cents").notNull(),
}, (t) => [check("booking_add_ons_qty", sql`${t.qty} > 0`)]);
