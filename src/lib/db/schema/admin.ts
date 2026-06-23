import { pgTable, pgEnum, text, integer, boolean, timestamp, uuid, uniqueIndex } from "drizzle-orm/pg-core";
import { bytea } from "./licenses";

export const adminRole = pgEnum("admin_role", ["owner", "staff"]);
export const policyType = pgEnum("policy_type", ["rental_terms", "cancellation", "privacy"]);

/** Maximum-lockdown accounts (spec §4): Argon2id hash, mandatory TOTP once
 *  enrolled, failed-attempt lockout. The TOTP secret is encrypted at rest. */
export const adminUsers = pgTable("admin_users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: adminRole("role").notNull().default("owner"),
  totpSecretEnc: bytea("totp_secret_enc"),
  totpLastUsedStep: integer("totp_last_used_step").notNull().default(0), // replay defense (RFC 6238)
  mfaEnabled: boolean("mfa_enabled").notNull().default(false),
  failedAttempts: integer("failed_attempts").notNull().default(0),
  lockoutCount: integer("lockout_count").notNull().default(0), // exponential backoff multiplier
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  // Second-factor (TOTP/recovery) throttle, separate from the password lockout
  // above. Keyed to the account so it can't be bypassed by rotating request
  // headers the way the IP/fingerprint rate limit can.
  mfaFailedAttempts: integer("mfa_failed_attempts").notNull().default(0),
  mfaLockedUntil: timestamp("mfa_locked_until", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Single-use MFA recovery codes: plaintext shown exactly once at enrollment,
 *  only sha256 hashes stored, consumed atomically (fort failure #10). */
export const adminRecoveryCodes = pgTable("admin_recovery_codes", {
  id: uuid("id").defaultRandom().primaryKey(),
  adminUserId: uuid("admin_user_id").notNull().references(() => adminUsers.id, { onDelete: "cascade" }),
  codeHash: text("code_hash").notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
}, (t) => [uniqueIndex("admin_recovery_codes_unique").on(t.adminUserId, t.codeHash)]);

/** Versioned policy documents (spec §10). Bookings store the version the
 *  customer accepted; old versions are kept for proof. */
export const policies = pgTable("policies", {
  id: uuid("id").defaultRandom().primaryKey(),
  type: policyType("type").notNull(),
  version: integer("version").notNull(),
  body: text("body").notNull(),
  publishedAt: timestamp("published_at", { withTimezone: true }),
}, (t) => [uniqueIndex("policies_type_version").on(t.type, t.version)]);
