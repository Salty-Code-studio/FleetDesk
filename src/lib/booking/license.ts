/**
 * Driver's licence validation + at-rest encryption (spec §8 — the most
 * sensitive data, handled with the most care). Plaintext licence number and DOB
 * are encrypted with the AAD-bound field crypto BEFORE they touch the database
 * and never appear in any response.
 */
import { z } from "zod";
import { encryptField } from "@/lib/crypto/fields";
import { Errors } from "@/lib/http/errors";
import { licenceDateBounds } from "@/lib/booking/license-bounds";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");

export const LicenseSchema = z.object({
  nameOnLicense: z.string().trim().min(1).max(120),
  licenseNumber: z.string().trim().min(1).max(60),
  issuingCountry: z.string().trim().min(2).max(60),
  issueDate: isoDate,
  expiryDate: isoDate,
  dob: isoDate,
}).strict();

export type LicenseInput = z.infer<typeof LicenseSchema>;

export { ageOn } from "@/lib/booking/age";
import { ageOn } from "@/lib/booking/age";

export { driverAgeBand, type DriverAgeBand } from "@/lib/booking/age";

/**
 * Enforce the licence rules: each date must sit inside the same window the
 * booking wizard offers (license-bounds.ts), it must stay valid through the
 * return date, the driver must meet the minimum age at pick-up, and issue must
 * precede expiry.
 *
 * The bounds are checked here and not only in the picker because the picker is
 * a convenience; this is the gate. Without it the server happily accepted a
 * 2030 date of birth and printed it on the rental contract.
 */
export function validateLicense(
  license: LicenseInput,
  ctx: { minDriverAge: number; rentalStart: string; rentalEnd: string; today: string },
): void {
  const bounds = licenceDateBounds(ctx.today);
  if (license.dob > bounds.dob.max || license.dob < bounds.dob.min) {
    throw Errors.badRequest("Please check the date of birth");
  }
  if (license.issueDate > bounds.issueDate.max || license.issueDate < bounds.issueDate.min) {
    throw Errors.badRequest("Please check the licence issue date");
  }
  if (license.expiryDate > bounds.expiryDate.max) {
    throw Errors.badRequest("Please check the licence expiry date");
  }
  if (license.issueDate >= license.expiryDate) {
    throw Errors.badRequest("Licence issue date must be before its expiry date");
  }
  if (license.expiryDate <= ctx.rentalEnd) {
    throw Errors.badRequest("Licence must stay valid through the return date");
  }
  const age = ageOn(license.dob, ctx.rentalStart);
  if (age < ctx.minDriverAge) {
    throw Errors.badRequest(`Driver must be at least ${ctx.minDriverAge} years old`);
  }
}

export interface EncryptedLicenseColumns {
  nameOnLicense: string;
  licenseNumberEnc: Buffer;
  issuingCountry: string;
  issueDate: string;
  expiryDate: string;
  dobEnc: Buffer;
}

/** Encrypt the sensitive fields, binding each ciphertext to its booking + column. */
export function encryptLicense(bookingId: string, license: LicenseInput): EncryptedLicenseColumns {
  return {
    nameOnLicense: license.nameOnLicense,
    licenseNumberEnc: encryptField(license.licenseNumber, `driver_licenses:${bookingId}:license_number`),
    issuingCountry: license.issuingCountry,
    issueDate: license.issueDate,
    expiryDate: license.expiryDate,
    dobEnc: encryptField(license.dob, `driver_licenses:${bookingId}:dob`),
  };
}
