/**
 * Demo-mode admin provisioning.
 *
 * The public product demo lets prospects click straight into the operations
 * dashboard without an authenticator. That door (POST /api/admin/auth/demo) is
 * gated ENTIRELY behind env.DEMO_MODE, and it only ever mints a session for the
 * single seeded demo admin defined here — never a real customer account.
 *
 * The demo admin is created with mfaEnabled=true (and a throwaway encrypted TOTP
 * secret) so it satisfies the requireAdmin guard, which blocks every /api/admin
 * route until an account has MFA enrolled. The demo door bypasses the password
 * and TOTP steps; the real login + MFA path is untouched.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { adminUsers } from "@/lib/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { encryptField } from "@/lib/crypto/fields";

export const DEMO_ADMIN_EMAIL = "demo@fleetdesk.app";

export type DemoAdmin = typeof adminUsers.$inferSelect;

/** The seeded demo admin, or null if it has not been provisioned yet. */
export async function findDemoAdmin(db: Db): Promise<DemoAdmin | null> {
  const [row] = await db.select().from(adminUsers).where(eq(adminUsers.email, DEMO_ADMIN_EMAIL));
  return row ?? null;
}

/**
 * Idempotently ensure the demo admin exists with MFA "enrolled" so the guard
 * admits it. Safe to run repeatedly (e.g. via `npm run demo:admin`): it creates
 * the account once and, if a pre-existing demo account somehow lacks MFA, flips
 * it on. Returns the demo admin row.
 */
export async function provisionDemoAdmin(db: Db): Promise<DemoAdmin> {
  const existing = await findDemoAdmin(db);
  if (existing) {
    if (existing.mfaEnabled) return existing;
    const [updated] = await db
      .update(adminUsers)
      .set({ mfaEnabled: true, updatedAt: new Date() })
      .where(eq(adminUsers.id, existing.id))
      .returning();
    return updated!;
  }

  const id = randomUUID();
  // A real (but never-used) encrypted TOTP secret keeps the record well-formed;
  // the demo door never verifies it. AAD is bound to the row id, like real
  // enrollment (src/app/api/admin/auth/mfa/verify uses the same convention).
  const totpSecretEnc = encryptField(randomBytes(20).toString("base64"), `admin_users:${id}:totp_secret`);
  // Password is a throwaway the demo never uses (entry is via the demo door).
  const passwordHash = await hashPassword(randomBytes(24).toString("base64url"));

  const [row] = await db
    .insert(adminUsers)
    .values({ id, email: DEMO_ADMIN_EMAIL, passwordHash, role: "owner", mfaEnabled: true, totpSecretEnc })
    .returning();
  return row!;
}
