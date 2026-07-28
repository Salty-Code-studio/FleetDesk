/**
 * Driver's licence validation + at-rest encryption (spec §8 — the most
 * sensitive data, handled with the most care). Plaintext licence number and DOB
 * are encrypted with the AAD-bound field crypto BEFORE they touch the database
 * and never appear in any response.
 */
import { z } from "zod";
import { encryptField } from "@/lib/crypto/fields";
import { Errors } from "@/lib/http/errors";

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

/** Whole years from `dob` to `onDate` (both YYYY-MM-DD). */
export function ageOn(dob: string, onDate: string): number {
  const [by, bm, bd] = dob.split("-").map(Number) as [number, number, number];
  const [oy, om, od] = onDate.split("-").map(Number) as [number, number, number];
  let age = oy - by;
  if (om < bm || (om === bm && od < bd)) age -= 1;
  return age;
}

export type DriverAgeBand = "under_min" | "young" | "standard";

/**
 * Classify the main driver's age at pick-up against the operator's thresholds
 * (workstream 5). under_min hard-rejects (validateLicense), young pays the
 * per-day fee, standard pays nothing extra. Pure so it is trivially testable
 * and reusable at quote and create time.
 */
export function driverAgeBand(
  dob: string,
  pickupDate: string,
  s: { minDriverAge: number; youngDriverAge: number },
): DriverAgeBand {
  const age = ageOn(dob, pickupDate);
  if (age < s.minDriverAge) return "under_min";
  if (age < s.youngDriverAge) return "young";
  return "standard";
}

/**
 * Enforce the licence rules: it must stay valid through the return date, the
 * driver must meet the minimum age at pick-up, and issue must precede expiry.
 */
export function validateLicense(
  license: LicenseInput,
  ctx: { minDriverAge: number; rentalStart: string; rentalEnd: string },
): void {
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
