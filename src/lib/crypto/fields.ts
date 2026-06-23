/**
 * Field-level encryption for license PII (fort: encryption-data-protection).
 *
 * AES-256-GCM with a random 12-byte IV per encryption and a 1-byte version
 * prefix for future key/algorithm rotation. GCM authenticates the ciphertext,
 * so any at-rest tampering fails decryption loudly instead of returning
 * silently corrupted plaintext.
 *
 * Stored layout: [version 1][iv 12][auth tag 16][ciphertext N]
 *
 * AAD (Additional Authenticated Data) is REQUIRED: it binds each ciphertext to
 * its row and column, so a value cannot be silently swapped between records or
 * fields even by someone with raw database write access (fort pattern:
 * encryption-data-protection / protectPii). Convention for driver licenses:
 *   encryptField(value, `driver_licenses:${bookingId}:license_number`)
 *   encryptField(value, `driver_licenses:${bookingId}:dob`)
 *
 * The key comes from DATA_ENCRYPTION_KEY (validated to exactly 32 bytes at
 * boot). Plaintext license numbers and dates of birth must never appear in
 * SQL, logs, or responses — encrypt BEFORE insert, decrypt only at the
 * admin-facing, audit-logged read path.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "@/env";

const VERSION = 1;
const IV_LEN = 12;
const TAG_LEN = 16;

export function encryptField(plaintext: string, aad: string): Buffer {
  if (!aad) throw new Error("encryptField: aad context is required");
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", env.DATA_ENCRYPTION_KEY, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptField(storedInput: Buffer | Uint8Array, aad: string): string {
  if (!aad) throw new Error("decryptField: aad context is required");
  // postgres-js returns bytea as Buffer; PGlite returns Uint8Array. Normalize.
  const stored = Buffer.isBuffer(storedInput) ? storedInput : Buffer.from(storedInput);
  if (stored.length < 1 + IV_LEN + TAG_LEN) throw new Error("Ciphertext too short");
  if (stored[0] !== VERSION) throw new Error(`Unknown ciphertext version: ${stored[0]}`);
  const iv = stored.subarray(1, 1 + IV_LEN);
  const tag = stored.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
  const ciphertext = stored.subarray(1 + IV_LEN + TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", env.DATA_ENCRYPTION_KEY, iv);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
