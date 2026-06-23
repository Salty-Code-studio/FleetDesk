import { randomBytes, createHash } from "node:crypto";
import QRCode from "qrcode";
import { eq } from "drizzle-orm";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { enforceRateLimit } from "@/lib/http/rate-limit";
import { Errors } from "@/lib/http/errors";
import { getDb } from "@/lib/db/client";
import { adminUsers, adminRecoveryCodes } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth/admin-auth";
import { encryptField } from "@/lib/crypto/fields";
import { generateTotpSecret, base32Encode, otpauthUri } from "@/lib/auth/totp";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

const RECOVERY_CODE_COUNT = 8;

/**
 * POST /api/admin/auth/mfa/enroll — begin TOTP enrollment.
 * Generates the secret + recovery codes but mfaEnabled STAYS FALSE until the
 * admin proves possession via /mfa/enroll/confirm (defeats hijacked
 * enrollment, fort failure #7). Recovery codes are returned exactly once;
 * only their hashes are stored.
 */
export const POST = withRoute(async (req) => {
  await enforceRateLimit(req, "auth", "admin-mfa-enroll");
  const { admin } = await requireAdmin(req, { allowMfaPending: true });
  if (admin.mfaEnabled) throw Errors.conflict("MFA is already enrolled");

  const secret = generateTotpSecret();
  const secretB32 = base32Encode(secret);
  const db = await getDb();

  await db.update(adminUsers).set({
    // store base64 of the raw secret, encrypted + AAD-bound to this admin row
    totpSecretEnc: encryptField(secret.toString("base64"), `admin_users:${admin.id}:totp_secret`),
    totpLastUsedStep: 0,
    updatedAt: new Date(),
  }).where(eq(adminUsers.id, admin.id));

  // Re-enrollment replaces any previous, unused recovery codes.
  await db.delete(adminRecoveryCodes).where(eq(adminRecoveryCodes.adminUserId, admin.id));
  const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () =>
    randomBytes(8).toString("base64url"),
  );
  await db.insert(adminRecoveryCodes).values(recoveryCodes.map((code) => ({
    adminUserId: admin.id,
    codeHash: createHash("sha256").update(code).digest("hex"),
  })));

  const uri = otpauthUri(admin.email, secret);
  const qrDataUrl = await QRCode.toDataURL(uri, { margin: 1, width: 220 });

  await audit({ actor: admin.id, action: "admin.mfa_enroll_started", entity: "admin_user", entityId: admin.id, req });

  // otpauthUri/manualKey/recoveryCodes appear ONLY in this response, never in logs.
  return json({ otpauthUri: uri, manualKey: secretB32, qrDataUrl, recoveryCodes }, req);
});
