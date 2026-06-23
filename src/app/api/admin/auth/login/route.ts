import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseJsonBody } from "@/lib/http/validate";
import { enforceRateLimit } from "@/lib/http/rate-limit";
import { Errors } from "@/lib/http/errors";
import { loginAdmin } from "@/lib/auth/admin-login";
import { createSession } from "@/lib/auth/sessions";
import { applySessionCookies } from "@/lib/auth/session-cookies";
import { trustedClientIp } from "@/lib/http/client-ip";

export const runtime = "nodejs";

const BodySchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(512),
}).strict();

/**
 * POST /api/admin/auth/login — first factor.
 * Per-IP rate limit (auth tier) + per-account lockout inside loginAdmin.
 * Success issues a session: mfaPending=true when TOTP is enrolled (the second
 * factor is owed), otherwise a full session with enrollRequired=true so the
 * shell forces enrollment before anything else (MFA is mandatory, spec §4).
 *
 * Every failure (wrong password, unknown email, AND a locked account) returns
 * the SAME generic 401 with no lock-specific status or Retry-After. Exposing a
 * 429 only for existing-but-locked accounts would be an account-existence
 * oracle. The lock is still enforced server-side (loginAdmin skips password
 * verification while locked) and the reason is in the audit log; brute-force
 * throttling is the per-IP limiter's job.
 */
export const POST = withRoute(async (req) => {
  await enforceRateLimit(req, "auth", "admin-login");
  const body = await parseJsonBody(req, BodySchema);

  const result = await loginAdmin(body.email, body.password, { req });
  if (!result.ok) {
    throw Errors.unauthorized("Invalid email or password");
  }

  const created = await createSession({
    subjectType: "admin",
    subjectId: result.adminId,
    mfaPending: result.mfaEnabled, // TOTP owed only when enrolled
    ip: trustedClientIp(req),
    ua: req.headers.get("user-agent"),
  });

  const res = json(
    result.mfaEnabled ? { mfaRequired: true } : { enrollRequired: true },
    req,
  );
  return applySessionCookies(res, created);
});
