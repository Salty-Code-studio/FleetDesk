/**
 * Route-level admin guard. DENY BY DEFAULT (OWASP A01): a request is only
 * admitted with a live, fully-authenticated admin session, CSRF-verified on
 * unsafe methods, and an allowed role. MFA-pending sessions (password ok,
 * TOTP outstanding) are admitted ONLY where explicitly allowed (the MFA
 * verification endpoints themselves).
 */
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { adminUsers } from "@/lib/db/schema";
import { resolveSession, type SessionRecord } from "@/lib/auth/sessions";
import { enforceCsrf } from "@/lib/auth/csrf";
import { SESSION_COOKIE } from "@/lib/auth/cookies";
import { Errors } from "@/lib/http/errors";

export type AdminRole = "owner" | "staff";
export type AdminUser = typeof adminUsers.$inferSelect;

export interface AdminContext {
  admin: AdminUser;
  session: SessionRecord;
}

export interface RequireAdminOptions {
  /**
   * Admit a session that is NOT yet fully second-factor-authenticated — either
   * it still owes the TOTP step (mfaPending) OR the admin has never enrolled MFA
   * (mfaEnabled=false). Granted ONLY to the MFA enroll/verify + me/logout
   * endpoints, so every other admin route stays two-factor by construction.
   */
  allowMfaPending?: boolean;
  roles?: AdminRole[];
}

export async function requireAdmin(
  req: Request,
  opts: RequireAdminOptions = {},
): Promise<AdminContext> {
  const cookieStore = await cookies();
  const session = await resolveSession(cookieStore.get(SESSION_COOKIE)?.value);
  if (!session || session.subjectType !== "admin") throw Errors.unauthorized();
  if (session.mfaPending && !opts.allowMfaPending) {
    throw Errors.unauthorized("Multi-factor authentication required");
  }

  // CSRF before acting on any cookie-authenticated, state-changing request.
  await enforceCsrf(req, session);

  const db = await getDb();
  const [admin] = await db.select().from(adminUsers).where(eq(adminUsers.id, session.subjectId));
  if (!admin) throw Errors.unauthorized("Account no longer exists");
  // Instant revocation (workstream 8): a deactivated account is dead even if a
  // session somehow survived the destroy-all at deactivation time.
  if (!admin.active) throw Errors.unauthorized("Account is deactivated");
  if (admin.lockedUntil && admin.lockedUntil.getTime() > Date.now()) {
    throw Errors.unauthorized("Account is locked");
  }
  // MFA is mandatory (spec §4). A never-enrolled admin holds a non-pending
  // session after first-factor login, so without this the shell's client-side
  // redirect would be the ONLY enrollment gate — leaving every /api/admin/**
  // mutation reachable with password alone. Enforce it at the guard, the real
  // boundary: block until enrolled, except on the enroll/me/logout endpoints.
  if (!admin.mfaEnabled && !opts.allowMfaPending) {
    throw Errors.unauthorized("Multi-factor authentication enrollment required");
  }

  // Deny-by-default on role: every admin route requires `owner` unless it opts
  // a wider set in explicitly. Today all accounts are owners, so this changes no
  // current behavior — but if a `staff` account is ever provisioned it gets 403
  // everywhere by default instead of silently inheriting full owner power.
  const roles = opts.roles ?? ["owner"];
  if (!roles.includes(admin.role)) throw Errors.forbidden();

  return { admin, session };
}
