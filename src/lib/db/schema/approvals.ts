import { pgTable, pgEnum, text, timestamp, uuid, jsonb, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { bookings } from "./bookings";

export const approvalStatus = pgEnum("approval_status", ["open", "confirmed", "declined", "closed"]);

/** One chat/email delivery of an approval ping. messageId lets the Telegram
 *  adapter edit the message in place after the decision. */
export interface ApprovalDelivery {
  channel: "telegram" | "email";
  to: string;
  messageId?: number;
  sentAt: string;
}

/**
 * Internal approval loop for desk-mode bookings (spec 2026-08-17): one OPEN
 * request per pending booking. A manager's tap (Telegram) or click (email)
 * decides it; "closed" means the booking got decided elsewhere (admin) or the
 * request went stale. The message loop is a convenience, never a gate: an
 * unanswered request leaves the booking pending forever.
 */
export const approvalRequests = pgTable("approval_requests", {
  id: uuid("id").defaultRandom().primaryKey(),
  bookingId: uuid("booking_id").notNull().references(() => bookings.id, { onDelete: "cascade" }),
  status: approvalStatus("status").notNull().default("open"),
  // sha256 hex of the signed email-link token (never the token itself).
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  sentTo: jsonb("sent_to").$type<ApprovalDelivery[]>().notNull().default(sql`'[]'::jsonb`),
  reminderCount: integer("reminder_count").notNull().default(0),
  remindedAt: timestamp("reminded_at", { withTimezone: true }),
  decidedBy: text("decided_by"),
  decidedChannel: text("decided_channel"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("approval_requests_open_booking_uq").on(t.bookingId).where(sql`${t.status} = 'open'`),
  index("approval_requests_status_idx").on(t.status),
]);

export type ApprovalRequest = typeof approvalRequests.$inferSelect;
