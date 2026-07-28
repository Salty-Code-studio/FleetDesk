import { z } from "zod";
import { createHash } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseJsonBody } from "@/lib/http/validate";
import { enforceRateLimit } from "@/lib/http/rate-limit";
import { Errors } from "@/lib/http/errors";
import { getDb, type Db } from "@/lib/db/client";
import { adminUsers, adminRecoveryCodes } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth/admin-auth";
import { rotateSession } from "@/lib/auth/sessions";
import { applySessionCookies } from "@/lib/auth/session-cookies";
import { decryptField } from "@/lib/crypto/fields";
import { verifyTotp } from "@/lib/auth/totp";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

const MFA_LOCK_THRESHOLD = 5;
const MFA_LOCK_SECONDS = 900; // 15 min. TOTP rotates every 30s, so 5 wrong is an attack or a broken authenticator, not a fumble.

/**
 * Per-account second-factor throttle. The IP/fingerprint rate limit is spoofable
 * (an attacker rotates request headers to mint a fresh bucket each try); this
 * lock is keyed to the account id from the mfa-pending session and cannot be
 * rotated away. Returns true when this failure trips the lockout.
 */
async function recordMfaFailure(db: Db, adminId: string, now: Date): Promise<boolean> {
  // ATOMIC increment in the database, not a read-modify-write from the
  // request-start snapshot: concurrent wrong guesses (reachable because the
  // IP/fingerprint limiter is spoofable) would otherwise all read the same
  // value and the cap would never engage. The failure that REACHES the
  // threshold resets the counter to 0 and sets the lock, both in one UPDATE.
  const lockUntil = new Date(now.getTime() + MFA_LOCK_SECONDS * 1000);
  const tripped = sql`${adminUsers.mfaFailedAttempts} + 1 >= ${MFA_LOCK_THRESHOLD}`;
  const [row] = await db.update(adminUsers)
    .set({
      mfaFailedAttempts: sql`CASE WHEN ${tripped} THEN 0 ELSE ${adminUsers.mfaFailedAttempts} + 1 END`,
      mfaLockedUntil: sql`CASE WHEN ${tripped} THEN ${lockUntil} ELSE ${adminUsers.mfaLockedUntil} END`,
      updatedAt: now,
    })
    .where(eq(adminUsers.id, adminId))
    .returning({ lockedUntil: adminUsers.mfaLockedUntil });
  return !!(row?.lockedUntil && row.lockedUntil.getTime() > now.getTime());
}

const BodySchema = z.object({
  code: z.string().trim().max(16).optional(),
  recoveryCode: z.string().trim().max(64).optional(),
}).strict().refine((b) => !!b.code !== !!b.recoveryCode, {
  message: "Provide exactly one of code or recoveryCode",
});

/**
 * POST /api/admin/auth/mfa/verify — second factor at login.
 * Requires the mfa-pending session from the password step. A 6-digit space is
 * tiny, so attempts ride the strict auth rate limit on top of the TOTP replay
 * defense. Success ROTATES the session to full (fixation defense).
 */
export const POST = withRoute(async (req) => {
  await enforceRateLimit(req, "auth", "admin-mfa-verify");
  const { admin, session } = await requireAdmin(req, { allowMfaPending: true });
  if (!session.mfaPending) throw Errors.badRequest("Session is already fully authenticated");
  if (!admin.mfaEnabled || !admin.totpSecretEnc) throw Errors.badRequest("MFA is not enrolled");

  const db = await getDb();
  const now = new Date();

  // Account-scoped lockout: reject before verifying while the account is locked.
  if (admin.mfaLockedUntil && admin.mfaLockedUntil.getTime() > now.getTime()) {
    await audit({ actor: admin.id, action: "admin.mfa_locked", entity: "admin_user", entityId: admin.id, req });
    throw Errors.unauthorized("Too many attempts, try again later");
  }

  const body = await parseJsonBody(req, BodySchema);

  if (body.code) {
    const secretB64 = decryptField(admin.totpSecretEnc, `admin_users:${admin.id}:totp_secret`);
    const result = verifyTotp(Buffer.from(secretB64, "base64"), body.code, admin.totpLastUsedStep);
    if (!result.ok) {
      const locked = await recordMfaFailure(db, admin.id, now);
      await audit({ actor: admin.id, action: locked ? "admin.mfa_lockout_engaged" : "admin.mfa_failed", entity: "admin_user", entityId: admin.id, req });
      throw Errors.unauthorized("Invalid code");
    }
    await db.update(adminUsers)
      .set({ totpLastUsedStep: result.usedStep!, mfaFailedAttempts: 0, mfaLockedUntil: null, updatedAt: now })
      .where(eq(adminUsers.id, admin.id));
    await audit({ actor: admin.id, action: "admin.mfa_verified", entity: "admin_user", entityId: admin.id, req });
  } else {
    const hash = createHash("sha256").update(body.recoveryCode!).digest("hex");
    // Atomic single-use consume: only this UPDATE can flip used_at from NULL.
    const consumed = await db.update(adminRecoveryCodes)
      .set({ usedAt: now })
      .where(and(
        eq(adminRecoveryCodes.adminUserId, admin.id),
        eq(adminRecoveryCodes.codeHash, hash),
        isNull(adminRecoveryCodes.usedAt),
      ))
      .returning({ id: adminRecoveryCodes.id });
    if (consumed.length === 0) {
      const locked = await recordMfaFailure(db, admin.id, now);
      await audit({ actor: admin.id, action: locked ? "admin.mfa_lockout_engaged" : "admin.recovery_code_failed", entity: "admin_user", entityId: admin.id, req });
      throw Errors.unauthorized("Invalid recovery code");
    }
    await db.update(adminUsers)
      .set({ mfaFailedAttempts: 0, mfaLockedUntil: null, updatedAt: now })
      .where(eq(adminUsers.id, admin.id));
    await audit({ actor: admin.id, action: "admin.recovery_code_used", entity: "admin_user", entityId: admin.id, req });
  }

  const rotated = await rotateSession(session, { mfaPending: false });
  // Canonical who-logged-in marker (seams: `admin.login` on BOTH login paths;
  // the staff-login route writes the same action), so "who logged in when" is
  // a single audit filter.
  await audit({ actor: admin.id, action: "admin.login", entity: "admin_user", entityId: admin.id, req });
  return applySessionCookies(json({ ok: true }, req), rotated);
});
