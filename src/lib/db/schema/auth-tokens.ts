import { pgTable, text, integer, timestamp, uuid, index } from "drizzle-orm/pg-core";

/**
 * Passwordless customer login tokens (spec §4). A 6-digit OTP (also embedded in
 * a magic link); only sha256(email:code) is stored. Single-use, short-lived,
 * attempt-capped. Issuing a new one invalidates the prior unused token.
 */
export const loginTokens = pgTable("login_tokens", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull(), // lowercased
  codeHash: text("code_hash").notNull(),
  attempts: integer("attempts").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("login_tokens_email").on(t.email)]);
