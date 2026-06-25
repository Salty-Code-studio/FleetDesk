import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Early-access waitlist leads from the marketing funnel.
 *
 * The public funnel captures book-a-demo / early-access leads now and flips to
 * real self-serve signup later (needs the unbuilt multi-tenant + Billing work).
 * Email is stored lowercased; normalize in app code (see /api/early-access).
 */
export const earlyAccessLeads = pgTable("early_access_leads", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(), // stored lowercased; normalize in app code
  company: text("company").notNull().default(""),
  country: text("country").notNull().default(""),
  fleetSize: text("fleet_size").notNull().default(""),
  message: text("message").notNull().default(""),
  source: text("source").notNull().default("early-access"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
