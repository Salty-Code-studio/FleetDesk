import { pgTable, integer, text, timestamp, date, jsonb, uuid, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/** A back-office manager who may confirm/decline desk-mode bookings. The
 *  inviteCode links their Telegram account (t.me/<bot>?start=<code>); chatId
 *  is set once they tap the invite link. Email is the fallback channel. */
export interface ApprovalManager {
  name: string;
  email?: string;
  inviteCode: string;
  chatId?: string;
}

/**
 * Single-row settings hub (spec §5): every amount the owner can edit without a
 * redeploy. The CHECK pins id to 1 so a second row is physically impossible.
 * Defaults are the spec placeholders pending owner confirmation (§16).
 */
export const settings = pgTable("settings", {
  id: integer("id").primaryKey().default(1),
  // Deposit-to-reserve = max(depositPercent% of the rental total, depositMinCents), capped at the total.
  depositPercent: integer("deposit_percent").notNull().default(25),
  depositMinCents: integer("deposit_min_cents").notNull().default(3000),
  // Free cancellation until this many hours before pickup; inside it, no refund.
  cancellationWindowHours: integer("cancellation_window_hours").notNull().default(48),
  currency: text("currency").notNull().default("USD"),
  minDriverAge: integer("min_driver_age").notNull().default(18),
  // Drivers at least minDriverAge but under youngDriverAge pay the per-day
  // young-driver fee (workstream 5). Set the fee to 0 to disable the surcharge.
  youngDriverAge: integer("young_driver_age").notNull().default(21),
  youngDriverFeeCentsPerDay: integer("young_driver_fee_cents_per_day").notNull().default(1000),
  turnaroundBufferHours: integer("turnaround_buffer_hours").notNull().default(24),
  openingTime: text("opening_time").notNull().default("08:00"),
  closingTime: text("closing_time").notNull().default("18:00"),
  minRentalDays: integer("min_rental_days").notNull().default(1),
  maxRentalDays: integer("max_rental_days").notNull().default(90),
  maxAdvanceDays: integer("max_advance_days").notNull().default(365),
  licenseRetentionDays: integer("license_retention_days").notNull().default(90), // auto-delete licence docs this long after return (spec §8/§16)
  adminAlertRecipients: jsonb("admin_alert_recipients").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  // Days before a vehicle document expiry at which the FIRST compliance warning
  // fires (wave 03). The one-week and overdue stages are fixed.
  complianceAlertDays: integer("compliance_alert_days").notNull().default(30),
  // Desk-mode approval loop (spec 2026-08-17): who gets the Confirm/Decline
  // pings, how soon to remind, and how many times. Managers double as the
  // inbound allowlist for the Telegram webhook.
  approvalManagers: jsonb("approval_managers").$type<ApprovalManager[]>().notNull().default(sql`'[]'::jsonb`),
  approvalReminderHours: integer("approval_reminder_hours").notNull().default(4),
  approvalMaxReminders: integer("approval_max_reminders").notNull().default(1),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [check("settings_singleton", sql`${t.id} = 1`)]);

/** Island-wide no-booking windows, editable in the dashboard (spec §7). */
export const blackoutDates = pgTable("blackout_dates", {
  id: uuid("id").defaultRandom().primaryKey(),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  reason: text("reason").notNull().default(""),
}, (t) => [check("blackout_dates_dates", sql`${t.endDate} > ${t.startDate}`)]);
