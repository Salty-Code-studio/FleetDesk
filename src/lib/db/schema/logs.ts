import { pgTable, text, timestamp, uuid, jsonb } from "drizzle-orm/pg-core";

/** Append-only. App code exposes insert + read; there is deliberately no
 *  update/delete path (spec §5: every admin action audit-logged). */
export const auditLog = pgTable("audit_log", {
  id: uuid("id").defaultRandom().primaryKey(),
  actor: text("actor").notNull(), // admin user id, customer id, or "system"
  action: text("action").notNull(),
  entity: text("entity").notNull(),
  entityId: text("entity_id"),
  before: jsonb("before"),
  after: jsonb("after"),
  ip: text("ip"),
  ua: text("ua"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** What we sent, to whom, when (spec §9). */
export const emailLog = pgTable("email_log", {
  id: uuid("id").defaultRandom().primaryKey(),
  to: text("to").notNull(),
  type: text("type").notNull(),
  status: text("status").notNull().default("queued"),
  providerId: text("provider_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
