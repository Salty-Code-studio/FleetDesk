import { pgTable, pgEnum, text, integer, timestamp, uuid, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { bookings } from "./bookings";

export const paymentType = pgEnum("payment_type", ["reservation_fee", "deposit"]);
export const paymentStatus = pgEnum("payment_status", ["pending", "succeeded", "failed", "refunded"]);

/** One row per Stripe charge attempt. Amounts are snapshots computed
 *  server-side; status flips on the SIGNED webhook only (spec §3). */
export const payments = pgTable("payments", {
  id: uuid("id").defaultRandom().primaryKey(),
  bookingId: uuid("booking_id").notNull().references(() => bookings.id),
  stripeCheckoutSessionId: text("stripe_checkout_session_id").unique(),
  stripePaymentIntentId: text("stripe_payment_intent_id").unique(),
  type: paymentType("type").notNull(),
  amountCents: integer("amount_cents").notNull(),
  currency: text("currency").notNull().default("USD"),
  status: paymentStatus("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // At most ONE PENDING payment per booking — the DB-level backstop against two
  // concurrent checkouts standing up two payable sessions (the checkout
  // booking-row lock + the already-succeeded guard cover the rest). Scoped to
  // 'pending' ONLY so the webhook can still upsert a 'succeeded' row for a
  // surplus/double-capture without colliding (it must reach its auto-refund path).
  uniqueIndex("payments_one_pending_per_booking").on(t.bookingId).where(sql`${t.status} = 'pending'`),
]);

/** Idempotency store for inbound Stripe webhooks: a redelivered event id is a
 *  no-op, so processing happens exactly once (fort webhook-signing-replay). */
export const stripeWebhookEvents = pgTable("stripe_webhook_events", {
  eventId: text("event_id").primaryKey(),
  type: text("type").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
