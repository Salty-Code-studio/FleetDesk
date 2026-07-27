import { pgTable, integer, text, timestamp, date, jsonb, uuid, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Single-row settings hub (spec §5): every amount the owner can edit without a
 * redeploy. The CHECK pins id to 1 so a second row is physically impossible.
 * Defaults are the spec placeholders pending owner confirmation (§16).
 */
export const settings = pgTable("settings", {
  id: integer("id").primaryKey().default(1),
  reservationFeeCents: integer("reservation_fee_cents").notNull().default(3000),
  currency: text("currency").notNull().default("USD"),
  minDriverAge: integer("min_driver_age").notNull().default(21),
  turnaroundBufferHours: integer("turnaround_buffer_hours").notNull().default(24),
  openingTime: text("opening_time").notNull().default("08:00"),
  closingTime: text("closing_time").notNull().default("18:00"),
  minRentalDays: integer("min_rental_days").notNull().default(1),
  maxRentalDays: integer("max_rental_days").notNull().default(90),
  maxAdvanceDays: integer("max_advance_days").notNull().default(365),
  licenseRetentionDays: integer("license_retention_days").notNull().default(90), // auto-delete licence docs this long after return (spec §8/§16)
  adminAlertRecipients: jsonb("admin_alert_recipients").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [check("settings_singleton", sql`${t.id} = 1`)]);

/** Island-wide no-booking windows, editable in the dashboard (spec §7). */
export const blackoutDates = pgTable("blackout_dates", {
  id: uuid("id").defaultRandom().primaryKey(),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  reason: text("reason").notNull().default(""),
}, (t) => [check("blackout_dates_dates", sql`${t.endDate} > ${t.startDate}`)]);
