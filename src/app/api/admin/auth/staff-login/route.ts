import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseJsonBody } from "@/lib/http/validate";
import { enforceRateLimit } from "@/lib/http/rate-limit";
import { Errors } from "@/lib/http/errors";
import { loginStaff } from "@/lib/auth/staff-login";
import { createSession } from "@/lib/auth/sessions";
import { applySessionCookies } from "@/lib/auth/session-cookies";
import { trustedClientIp } from "@/lib/http/client-ip";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

const BodySchema = z.object({
  code: z.string().trim().regex(/^\d{6}$/, "Code must be 6 digits"),
}).strict();

/**
 * POST /api/admin/auth/staff-login — staff second login path (workstream 8).
 * A personal 6-digit code maps to exactly one staff admin_user; success mints
 * a FULL session bound to that person, so every mutate() audit entry carries
 * their id. Defenses: auth-tier per-client rate limit here, the shared 5-fail
 * 15-minute lockout inside loginStaff, hashed-only code storage, and instant
 * owner revocation. Every failure mode returns the SAME generic 401 (no
 * lock/deactivation oracle). Staff rows are provisioned mfaEnabled=true with a
 * throwaway secret (demo-admin pattern), so requireAdmin's mandatory-MFA gate
 * admits the session without weakening the owner path.
 */
export const POST = withRoute(async (req) => {
  await enforceRateLimit(req, "auth", "admin-staff-login");
  const body = await parseJsonBody(req, BodySchema);

  const result = await loginStaff(body.code, { req });
  if (!result.ok) throw Errors.unauthorized("Invalid code");

  const created = await createSession({
    subjectType: "admin",
    subjectId: result.adminId,
    mfaPending: false,
    ip: trustedClientIp(req),
    ua: req.headers.get("user-agent"),
  });

  // Canonical who-logged-in marker (seams: `admin.login` on BOTH login paths).
  await audit({ actor: result.adminId, action: "admin.login", entity: "admin_user", entityId: result.adminId, req });
  return applySessionCookies(json({ ok: true }, req), created);
});
