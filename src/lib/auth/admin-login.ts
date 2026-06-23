/**
 * Admin first-factor login with progressive lockout (spec §4, fort
 * account-security pattern).
 *
 * Properties:
 *   - Anti-enumeration: unknown email and wrong password take the same code
 *     path (a dummy Argon2id verify burns comparable time) and produce the
 *     same generic result.
 *   - Lockout: LOCK_THRESHOLD consecutive failures lock the account for
 *     LOCK_BASE_SECONDS * 2^lockoutCount, capped at LOCK_MAX_SECONDS.
 *     A locked account rejects BEFORE password verification.
 *   - Success resets the counters and is audit-logged, as is every failure
 *     and every lockout engagement.
 */
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { adminUsers } from "@/lib/db/schema";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { audit } from "@/lib/audit";

export const LOCK_THRESHOLD = 5;
export const LOCK_BASE_SECONDS = 60;
export const LOCK_MAX_SECONDS = 3600;

/** Precomputed at module load so unknown-email logins burn real Argon2id time. */
const dummyHashPromise = hashPassword("dummy-timing-equalizer-not-a-credential");

export type LoginResult =
  | { ok: true; adminId: string; mfaEnabled: boolean }
  | { ok: false; retryAfterSec?: number };

export async function loginAdmin(
  emailRaw: string,
  password: string,
  ctx: { req?: Request } = {},
  now = new Date(),
): Promise<LoginResult> {
  const email = emailRaw.trim().toLowerCase();
  const db = await getDb();
  const [admin] = await db.select().from(adminUsers).where(eq(adminUsers.email, email));

  if (!admin) {
    // Burn comparable work, then the same generic failure.
    await verifyPassword(await dummyHashPromise, password);
    await audit({ actor: "anonymous", action: "admin.login_failed", entity: "admin_user", req: ctx.req });
    return { ok: false };
  }

  if (admin.lockedUntil && admin.lockedUntil.getTime() > now.getTime()) {
    const retryAfterSec = Math.ceil((admin.lockedUntil.getTime() - now.getTime()) / 1000);
    await audit({
      actor: admin.id, action: "admin.login_rejected_locked", entity: "admin_user",
      entityId: admin.id, req: ctx.req,
    });
    return { ok: false, retryAfterSec };
  }

  const valid = await verifyPassword(admin.passwordHash, password);
  if (!valid) {
    const failedAttempts = admin.failedAttempts + 1;
    if (failedAttempts >= LOCK_THRESHOLD) {
      const backoffSec = Math.min(LOCK_BASE_SECONDS * 2 ** admin.lockoutCount, LOCK_MAX_SECONDS);
      await db.update(adminUsers).set({
        failedAttempts: 0,
        lockoutCount: admin.lockoutCount + 1,
        lockedUntil: new Date(now.getTime() + backoffSec * 1000),
        updatedAt: now,
      }).where(eq(adminUsers.id, admin.id));
      await audit({
        actor: admin.id, action: "admin.lockout_engaged", entity: "admin_user",
        entityId: admin.id, after: { backoffSec }, req: ctx.req,
      });
      return { ok: false, retryAfterSec: backoffSec };
    }
    await db.update(adminUsers).set({ failedAttempts, updatedAt: now }).where(eq(adminUsers.id, admin.id));
    await audit({
      actor: admin.id, action: "admin.login_failed", entity: "admin_user",
      entityId: admin.id, req: ctx.req,
    });
    return { ok: false };
  }

  await db.update(adminUsers).set({
    failedAttempts: 0,
    lockoutCount: 0,
    lockedUntil: null,
    updatedAt: now,
  }).where(eq(adminUsers.id, admin.id));
  await audit({
    actor: admin.id, action: "admin.login_succeeded", entity: "admin_user",
    entityId: admin.id, req: ctx.req,
  });
  return { ok: true, adminId: admin.id, mfaEnabled: admin.mfaEnabled };
}
