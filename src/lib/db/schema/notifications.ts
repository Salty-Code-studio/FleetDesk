import { pgTable, pgEnum, text, timestamp, uuid, index } from "drizzle-orm/pg-core";
import { bookings } from "./bookings";

export const notificationLevel = pgEnum("notification_level", ["info", "success", "warning", "critical"]);

/**
 * Admin-facing in-app notification feed (the ops-board bell). One row per
 * business event worth surfacing to the owner — new booking, payment received,
 * payment failed, cancellation, low add-on stock. External delivery (owner
 * email/WhatsApp, customer reminders) is best-effort and logged in email_log;
 * this table is the durable, owner-visible record that survives a missed email.
 */
export const notifications = pgTable("notifications", {
  id: uuid("id").defaultRandom().primaryKey(),
  level: notificationLevel("level").notNull().default("info"),
  type: text("type").notNull(), // machine key, e.g. 'booking.created', 'payment.failed'
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  bookingId: uuid("booking_id").references(() => bookings.id, { onDelete: "set null" }), // deep-link target
  readAt: timestamp("read_at", { withTimezone: true }), // null = unread
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // The feed query is "newest first"; the unread badge counts read_at IS NULL.
  index("notifications_created_idx").on(t.createdAt),
]);
