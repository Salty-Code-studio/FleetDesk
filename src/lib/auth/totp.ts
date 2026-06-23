/**
 * TOTP (RFC 6238) over the node standard library — ported from fort
 * `authn-passwordless-mfa` §8-11. No third-party OTP dependency.
 *
 * Hardening properties:
 *   - 160-bit CSPRNG secrets (RFC 4226 minimum recommendation)
 *   - tight drift window: current step ±1 only
 *   - replay defense: a time-step ≤ lastUsedStep is never accepted again,
 *     so a shoulder-surfed or intercepted code cannot be reused
 *   - constant-time code comparison
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const TOTP_DRIFT_WINDOW = 1; // accept current step ±1 (tolerates clock skew)
const TOTP_SECRET_BYTES = 20; // 160 bits

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // RFC 4648

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i]!;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Compute the HOTP code for a given secret and counter (RFC 4226 §5.3). */
function hotp(secret: Buffer, counter: number, digits: number): string {
  const buf = Buffer.alloc(8);
  // 64-bit big-endian counter; JS bitwise ops are 32-bit, so split the writes.
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = createHmac("sha1", secret).update(buf).digest(); // RFC 6238 default
  const offset = hmac[hmac.length - 1]! & 0x0f; // dynamic truncation
  const binCode =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return (binCode % 10 ** digits).toString().padStart(digits, "0");
}

export function currentStep(atMs = Date.now()): number {
  return Math.floor(atMs / 1000 / TOTP_PERIOD_SECONDS);
}

function constantTimeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Fresh 160-bit secret for enrollment. */
export function generateTotpSecret(): Buffer {
  return randomBytes(TOTP_SECRET_BYTES);
}

/** otpauth:// provisioning URI (Key URI Format), fully URL-encoded. */
export function otpauthUri(accountLabel: string, secret: Buffer, issuerName = "FleetDesk Admin"): string {
  const issuer = encodeURIComponent(issuerName);
  const label = encodeURIComponent(`${issuerName}:${accountLabel}`);
  const base32 = base32Encode(secret);
  return (
    `otpauth://totp/${label}?secret=${base32}&issuer=${issuer}` +
    `&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_SECONDS}`
  );
}

export interface TotpVerifyResult {
  ok: boolean;
  /** The time-step that matched; persist as the new lastUsedStep on success. */
  usedStep?: number;
}

/**
 * Verify a submitted code against the secret. Steps at or before lastUsedStep
 * are rejected even with a correct code (replay defense). The caller MUST
 * persist `usedStep` on success and rate-limit attempts (6 digits = 10^6).
 */
export function verifyTotp(
  secret: Buffer,
  codeRaw: unknown,
  lastUsedStep: number,
  atMs = Date.now(),
): TotpVerifyResult {
  if (typeof codeRaw !== "string") return { ok: false };
  const code = codeRaw.trim().replace(/\s/g, "");
  if (!/^\d{6}$/.test(code)) return { ok: false }; // validate at the boundary

  const now = currentStep(atMs);
  for (let i = -TOTP_DRIFT_WINDOW; i <= TOTP_DRIFT_WINDOW; i++) {
    const step = now + i;
    if (step <= lastUsedStep) continue; // never accept a step twice
    const expected = hotp(secret, step, TOTP_DIGITS);
    if (constantTimeEqualStr(code, expected)) {
      return { ok: true, usedStep: step };
    }
  }
  return { ok: false };
}
