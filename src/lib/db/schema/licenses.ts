import { pgTable, text, date, timestamp, uuid, customType } from "drizzle-orm/pg-core";
import { bookings } from "./bookings";

/** Raw bytes column for AES-256-GCM ciphertext (see src/lib/crypto/fields.ts). */
export const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

/**
 * The most sensitive table (spec §8). License number and date of birth are
 * encrypted app-side BEFORE insert; plaintext never reaches the database, the
 * logs, or any public response. `documentRef` points at private object storage,
 * opened only by admins via short-lived signed URLs. `retainUntil` drives the
 * auto-delete retention timer after rental completion.
 */
export const driverLicenses = pgTable("driver_licenses", {
  id: uuid("id").defaultRandom().primaryKey(),
  bookingId: uuid("booking_id").notNull().unique().references(() => bookings.id, { onDelete: "cascade" }),
  nameOnLicense: text("name_on_license").notNull(),
  licenseNumberEnc: bytea("license_number_enc").notNull(),
  issuingCountry: text("issuing_country").notNull(),
  issueDate: date("issue_date").notNull(),
  expiryDate: date("expiry_date").notNull(),
  dobEnc: bytea("dob_enc").notNull(),
  documentRef: text("document_ref"),
  retainUntil: timestamp("retain_until", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
