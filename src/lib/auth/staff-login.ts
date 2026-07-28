/**
 * Staff code login (feature wave workstream 8): a staff person signs in with a
 * personal 6-digit code. Deliberately weaker than the owner's password + TOTP;
 * accepted (spec-recorded trade-off) because staff scope excludes money
 * movement and settings, and four controls defend the code path: the auth-tier
 * rate limit at the route, the shared lockout below, hashed-only storage, and
 * instant owner revocation (deactivate / regenerate).
 *
 * Lockout model: a wrong code matches no account, so failures cannot be pinned
 * on one row. Every no-match failure therefore atomically increments
 * code_failed_attempts on EVERY active staff row (the recordMfaFailure
 * CASE-WHEN pattern from the MFA verify route); reaching
 * STAFF_LOCK_THRESHOLD sets code_locked_until = now + STAFF_LOCK_SECONDS and
 * resets the counter in the same UPDATE. All rows move in lockstep, so the
 * whole staff-code path locks together for 15 minutes. The owner's
 * password + TOTP login is never affected, so the desk always has a way in.
 */
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { adminUsers } from "@/lib/db/schema";
import { hashStaffCode } from "@/lib/admin/staff";
import { audit } from "@/lib/audit";

export const STAFF_LOCK_THRESHOLD = 5;
export const STAFF_LOCK_SECONDS = 900; // 15 minutes

export type StaffLoginResult =
  | { ok: true; adminId: string; name: string | null }
  | { ok: false };

/** Atomic collective failure counter. Returns true when this failure engaged
 *  (or found already engaged) a fresh lock on at least one row. */
async function recordStaffFailure(now: Date): Promise<boolean> {
  const db = await getDb();
  const lockUntil = new Date(now.getTime() + STAFF_LOCK_SECONDS * 1000);
  const tripped = sql`${adminUsers.codeFailedAttempts} + 1 >= ${STAFF_LOCK_THRESHOLD}`;
  const rows = await db.update(adminUsers)
    .set({
      codeFailedAttempts: sql`CASE WHEN ${tripped} THEN 0 ELSE ${adminUsers.codeFailedAttempts} + 1 END`,
      codeLockedUntil: sql`CASE WHEN ${tripped} THEN ${lockUntil} ELSE ${adminUsers.codeLockedUntil} END`,
      updatedAt: now,
    })
    .where(and(
      eq(adminUsers.role, "staff"),
      eq(adminUsers.active, true),
      isNotNull(adminUsers.loginCodeHash),
    ))
    .returning({ lockedUntil: adminUsers.codeLockedUntil });
  return rows.some((r) => r.lockedUntil !== null && r.lockedUntil.getTime() > now.getTime());
}

/** Verify a staff code. Generic { ok: false } on EVERY failure mode (no match,
 *  deactivated, locked) so the response never reveals which one it was; the
 *  audit log records the specific reason. `now` is injectable for tests. */
export async function loginStaff(
  code: string,
  ctx: { req?: Request } = {},
  now = new Date(),
): Promise<StaffLoginResult> {
  const db = await getDb();
  const codeHash = hashStaffCode(code);
  const [match] = await db.select().from(adminUsers)
    .where(and(eq(adminUsers.loginCodeHash, codeHash), eq(adminUsers.role, "staff")));

  if (!match) {
    const locked = await recordStaffFailure(now);
    await audit({
      actor: "anonymous",
      action: locked ? "admin.staff_lockout_engaged" : "admin.staff_login_failed",
      entity: "admin_user",
      req: ctx.req,
    });
    return { ok: false };
  }

  if (!match.active) {
    await audit({
      actor: match.id, action: "admin.staff_login_rejected_inactive",
      entity: "admin_user", entityId: match.id, req: ctx.req,
    });
    return { ok: false };
  }

  if (match.codeLockedUntil && match.codeLockedUntil.getTime() > now.getTime()) {
    await audit({
      actor: match.id, action: "admin.staff_login_rejected_locked",
      entity: "admin_user", entityId: match.id, req: ctx.req,
    });
    return { ok: false };
  }

  await db.update(adminUsers)
    .set({ codeFailedAttempts: 0, codeLockedUntil: null, updatedAt: now })
    .where(eq(adminUsers.id, match.id));
  return { ok: true, adminId: match.id, name: match.name };
}
