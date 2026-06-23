import argon2 from "argon2";

/**
 * Password hashing with Argon2id (OWASP Password Storage Cheat Sheet).
 *
 * Why Argon2id:
 *   - Memory-hard => resistant to GPU/ASIC cracking.
 *   - `argon2id` variant balances side-channel and GPU resistance.
 *   - The salt is generated and embedded in the encoded hash automatically;
 *     we never manage salts by hand.
 *
 * Parameters below meet/exceed current OWASP guidance. Tune `memoryCost` upward
 * if your hardware allows (more memory = stronger), but verify it stays within
 * your container's memory limits to avoid a self-inflicted DoS.
 */

const OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19_456, // ~19 MiB
  timeCost: 2,
  parallelism: 1,
};

export async function hashPassword(plaintext: string): Promise<string> {
  return argon2.hash(plaintext, OPTIONS);
}

/**
 * Verify a password. Returns false on ANY error (fail-closed) rather than
 * throwing, so a malformed stored hash can never be treated as a match.
 * argon2.verify is constant-time with respect to the stored hash.
 */
export async function verifyPassword(storedHash: string, plaintext: string): Promise<boolean> {
  try {
    return await argon2.verify(storedHash, plaintext);
  } catch {
    return false;
  }
}
