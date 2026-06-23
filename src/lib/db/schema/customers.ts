import { pgTable, text, boolean, timestamp, uuid } from "drizzle-orm/pg-core";

/** Customers are passwordless (magic link / OTP per spec §4) — no password column, ever. */
export const customers = pgTable("customers", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull().unique(), // stored lowercased; normalize in app code
  name: text("name").notNull().default(""),
  phone: text("phone").notNull().default(""),
  emailVerified: boolean("email_verified").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
