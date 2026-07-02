import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { enforceRateLimit } from "@/lib/http/rate-limit";
import { Errors } from "@/lib/http/errors";
import { env } from "@/env";
import { getDb } from "@/lib/db/client";
import { createSession } from "@/lib/auth/sessions";
import { applySessionCookies } from "@/lib/auth/session-cookies";
import { trustedClientIp } from "@/lib/http/client-ip";
import { findDemoAdmin } from "@/lib/auth/demo";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * POST /api/admin/auth/demo — one-click demo entry for the public product demo.
 *
 * Gated ENTIRELY behind DEMO_MODE: when it is off, the route 404s as if it does
 * not exist, so a real customer deployment never exposes a password/MFA-free
 * admin door. When on, it mints a FULL (non-mfaPending) admin session for the
 * seeded demo admin (mfaEnabled=true, role owner) so prospects can explore the
 * ops dashboard with sample data. The real login + MFA path
 * (/api/admin/auth/login and /mfa/verify) is deliberately left untouched.
 */
export const POST = withRoute(async (req) => {
  if (!env.DEMO_MODE) throw Errors.notFound();
  await enforceRateLimit(req, "auth", "admin-demo-login");

  const db = await getDb();
  const admin = await findDemoAdmin(db);
  // Not provisioned (run `npm run demo:admin`) — stay invisible rather than 500.
  if (!admin || !admin.mfaEnabled) throw Errors.notFound();

  const created = await createSession({
    subjectType: "admin",
    subjectId: admin.id,
    mfaPending: false,
    ip: trustedClientIp(req),
    ua: req.headers.get("user-agent"),
  });

  await audit({ actor: admin.id, action: "admin.demo_login", entity: "admin_user", entityId: admin.id, req });
  return applySessionCookies(json({ ok: true }, req), created);
});
