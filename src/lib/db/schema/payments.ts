import { pgTable, pgEnum, text, integer, timestamp, uuid, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { bookings } from "./bookings";

// reservation_fee + deposit exist only on historical (pre-wave) rows.
// New charges are rental_deposit (partial, holds the car), rental_full
// (whole rental paid online), or extension (delta for added days).
export const paymentType = pgEnum("payment_type", ["reservation_fee", "deposit", "rental_deposit", "rental_full", "extension"]);
export const paymentStatus = pgEnum("payment_status", ["pending", "succeeded", "failed", "refunded"]);
export const paymentMethod = pgEnum("payment_method", ["stripe", "desk"]);

/** One row per charge. Amounts are snapshots computed server-side; Stripe rows
 *  flip status on the SIGNED webhook only; desk rows are settled on insert. */
export const payments = pgTable("payments", {
  id: uuid("id").defaultRandom().primaryKey(),
  bookingId: uuid("booking_id").notNull().references(() => bookings.id),
  stripeCheckoutSessionId: text("stripe_checkout_session_id").unique(),
  stripePaymentIntentId: text("stripe_payment_intent_id").unique(),
  type: paymentType("type").notNull(),
  method: paymentMethod("method").notNull().default("stripe"),
  amountCents: integer("amount_cents").notNull(),
  refundedCents: integer("refunded_cents").notNull().default(0),
  currency: text("currency").notNull().default("USD"),
  status: paymentStatus("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // At most ONE PENDING payment per booking (unchanged rationale, see git history).
  uniqueIndex("payments_one_pending_per_booking").on(t.bookingId).where(sql`${t.status} = 'pending'`),
]);

/** Idempotency store for inbound Stripe webhooks: a redelivered event id is a
 *  no-op, so processing happens exactly once (fort webhook-signing-replay). */
export const stripeWebhookEvents = pgTable("stripe_webhook_events", {
  eventId: text("event_id").primaryKey(),
  type: text("type").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
