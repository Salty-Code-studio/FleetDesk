import { z } from "zod";
import { eq } from "drizzle-orm";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseJsonBody } from "@/lib/http/validate";
import { enforceRateLimit } from "@/lib/http/rate-limit";
import { Errors } from "@/lib/http/errors";
import { getDb } from "@/lib/db/client";
import { adminUsers } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth/admin-auth";
import { rotateSession } from "@/lib/auth/sessions";
import { applySessionCookies } from "@/lib/auth/session-cookies";
import { decryptField } from "@/lib/crypto/fields";
import { verifyTotp } from "@/lib/auth/totp";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

const BodySchema = z.object({ code: z.string().trim().max(16) }).strict();

/**
 * POST /api/admin/auth/mfa/enroll/confirm — prove possession, then enable.
 * Only a valid code from the authenticator flips mfaEnabled=true.
 */
export const POST = withRoute(async (req) => {
  await enforceRateLimit(req, "auth", "admin-mfa-confirm");
  const { admin, session } = await requireAdmin(req, { allowMfaPending: true });
  if (admin.mfaEnabled) throw Errors.conflict("MFA is already enrolled");
  if (!admin.totpSecretEnc) throw Errors.badRequest("Enrollment has not been started");

  const body = await parseJsonBody(req, BodySchema);
  const secretB64 = decryptField(admin.totpSecretEnc, `admin_users:${admin.id}:totp_secret`);
  const result = verifyTotp(Buffer.from(secretB64, "base64"), body.code, admin.totpLastUsedStep);
  if (!result.ok) throw Errors.unauthorized("Invalid code");

  const db = await getDb();
  await db.update(adminUsers).set({
    mfaEnabled: true,
    totpLastUsedStep: result.usedStep!,
    updatedAt: new Date(),
  }).where(eq(adminUsers.id, admin.id));

  await audit({ actor: admin.id, action: "admin.mfa_enrolled", entity: "admin_user", entityId: admin.id, req });

  const rotated = await rotateSession(session, { mfaPending: false });
  return applySessionCookies(json({ ok: true }, req), rotated);
});
