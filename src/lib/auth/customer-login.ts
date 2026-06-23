/**
 * Passwordless customer login (spec §4): a 6-digit OTP, single-use, 15-minute
 * expiry, attempt-capped. The code is hashed (sha256 of email:code) so the
 * database never holds a usable code. Issuing a new code invalidates the old.
 * Rate limiting of the REQUEST endpoint is enforced at the route.
 */
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { eq, and, isNull } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { loginTokens } from "@/lib/db/schema";

export const TOKEN_TTL_MINUTES = 15;
export const MAX_ATTEMPTS = 5;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function hashCode(email: string, code: string): string {
  return createHash("sha256").update(`${email}:${code}`).digest("hex");
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Issue a fresh OTP for `email`, invalidating any prior unused one. Returns
 *  the plaintext code (to email) — never stored, never logged. */
export async function issueLoginToken(emailRaw: string, now = new Date()): Promise<{ code: string }> {
  const email = normalizeEmail(emailRaw);
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const db = await getDb();
  // Invalidate prior unused tokens for this email.
  await db.delete(loginTokens).where(and(eq(loginTokens.email, email), isNull(loginTokens.usedAt)));
  await db.insert(loginTokens).values({
    email,
    codeHash: hashCode(email, code),
    expiresAt: new Date(now.getTime() + TOKEN_TTL_MINUTES * 60_000),
  });
  return { code };
}

export type VerifyResult = { ok: true; email: string } | { ok: false };

/** Verify an OTP. Marks the token used on success; caps attempts on misses. */
export async function verifyLoginToken(emailRaw: string, code: unknown, now = new Date()): Promise<VerifyResult> {
  const email = normalizeEmail(emailRaw);
  if (typeof code !== "string" || !/^\d{6}$/.test(code.trim())) return { ok: false };
  const db = await getDb();
  const [token] = await db.select().from(loginTokens)
    .where(and(eq(loginTokens.email, email), isNull(loginTokens.usedAt)));
  if (!token) return { ok: false };
  if (token.expiresAt.getTime() <= now.getTime()) return { ok: false };
  if (token.attempts >= MAX_ATTEMPTS) return { ok: false };

  if (!constantTimeEqual(token.codeHash, hashCode(email, code.trim()))) {
    await db.update(loginTokens).set({ attempts: token.attempts + 1 }).where(eq(loginTokens.id, token.id));
    return { ok: false };
  }
  await db.update(loginTokens).set({ usedAt: now }).where(eq(loginTokens.id, token.id));
  return { ok: true, email };
}
