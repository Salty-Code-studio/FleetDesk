import { pgTable, pgEnum, text, boolean, timestamp, uuid, index } from "drizzle-orm/pg-core";

export const sessionSubject = pgEnum("session_subject", ["admin", "customer"]);

/**
 * Server-side sessions (spec §4). The cookie carries `<sid>.<HMAC(sid)>`;
 * the database stores ONLY sha256(sid), so a database read cannot yield a
 * usable cookie value. Absolute expiry via expiresAt, idle expiry enforced
 * in code from lastSeenAt + SESSION_IDLE_TTL_SECONDS. mfaPending marks the
 * half-authenticated state between password and TOTP.
 */
export const sessions = pgTable("sessions", {
  idHash: text("id_hash").primaryKey(),
  subjectType: sessionSubject("subject_type").notNull(),
  subjectId: uuid("subject_id").notNull(),
  csrfToken: text("csrf_token").notNull(),
  mfaPending: boolean("mfa_pending").notNull().default(false),
  ip: text("ip"),
  ua: text("ua"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => [index("sessions_subject").on(t.subjectType, t.subjectId)]);
