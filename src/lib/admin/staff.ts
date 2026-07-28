/**
 * Owner-managed staff accounts (feature wave workstream 8).
 *
 * A staff person signs in with a personal 6-digit code instead of the owner's
 * password + TOTP. The code is stored ONLY as sha256("staff-code:" + code),
 * the same hashing pattern as login_tokens.codeHash, and is shown to the owner
 * exactly once at creation or regeneration.
 *
 * Staff rows satisfy the mandatory-MFA requireAdmin gate the same way the demo
 * admin does (src/lib/auth/demo.ts): mfaEnabled=true with a throwaway
 * encrypted TOTP secret that is never verified, plus an unusable random
 * password. The password + TOTP login path therefore stays owner-only by
 * construction: staff cannot know their random password, and even the password
 * would still owe a TOTP they cannot produce.
 */
import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { adminUsers } from "@/lib/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { encryptField } from "@/lib/crypto/fields";
import { destroyAllForSubject } from "@/lib/auth/sessions";
import { Errors } from "@/lib/http/errors";

/** sha256("staff-code:" + code) — global (not per-account) because at login the
 *  code is all we have; the account is found BY the hash. */
export function hashStaffCode(code: string): string {
  return createHash("sha256").update(`staff-code:${code}`).digest("hex");
}

/** Draw codes until one collides with no existing account, so a code always
 *  identifies exactly one person. Creation is owner-only and effectively
 *  serial, so the check-then-insert race is theoretical; the retry cap keeps
 *  the loop finite even if the code space ever got crowded. */
async function generateUniqueCode(): Promise<{ code: string; codeHash: string }> {
  const db = await getDb();
  for (let i = 0; i < 10; i++) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const codeHash = hashStaffCode(code);
    const [clash] = await db.select({ id: adminUsers.id }).from(adminUsers)
      .where(eq(adminUsers.loginCodeHash, codeHash));
    if (!clash) return { code, codeHash };
  }
  throw Errors.conflict("Could not generate a unique staff code, please try again");
}

export interface StaffListRow {
  id: string;
  name: string | null;
  active: boolean;
  createdAt: Date;
}

export async function listStaff(): Promise<StaffListRow[]> {
  const db = await getDb();
  return db.select({
    id: adminUsers.id,
    name: adminUsers.name,
    active: adminUsers.active,
    createdAt: adminUsers.createdAt,
  }).from(adminUsers)
    .where(eq(adminUsers.role, "staff"))
    .orderBy(adminUsers.createdAt);
}

export interface CreatedStaff { id: string; name: string; code: string }

export async function createStaff(name: string): Promise<CreatedStaff> {
  const db = await getDb();
  const { code, codeHash } = await generateUniqueCode();
  const id = randomUUID();
  // Same well-formedness trick as the demo admin: a real (never verified)
  // encrypted TOTP secret bound to the row id via AAD.
  const totpSecretEnc = encryptField(randomBytes(20).toString("base64"), `admin_users:${id}:totp_secret`);
  // Unusable password: random, never revealed, never needed.
  const passwordHash = await hashPassword(randomBytes(24).toString("base64url"));
  await db.insert(adminUsers).values({
    id,
    email: `staff-${id}@staff.local`, // placeholder; staff have no real email
    passwordHash,
    role: "staff",
    name,
    mfaEnabled: true,
    totpSecretEnc,
    loginCodeHash: codeHash,
  });
  return { id, name, code };
}

/** Resolve a STAFF row by id; owners are invisible to this API so the staff
 *  management surface can never lock out or rekey the owner. */
async function findStaff(id: string) {
  const db = await getDb();
  const [row] = await db.select().from(adminUsers)
    .where(and(eq(adminUsers.id, id), eq(adminUsers.role, "staff")));
  if (!row) throw Errors.notFound("Staff member not found");
  return row;
}

export async function regenerateStaffCode(id: string): Promise<{ code: string }> {
  const staff = await findStaff(id);
  const db = await getDb();
  const { code, codeHash } = await generateUniqueCode();
  await db.update(adminUsers).set({
    loginCodeHash: codeHash,
    codeFailedAttempts: 0,
    codeLockedUntil: null,
    updatedAt: new Date(),
  }).where(eq(adminUsers.id, staff.id));
  // A lost or shared code is the usual reason to regenerate, so treat the old
  // code as compromised: revoke every live session for this person.
  await destroyAllForSubject("admin", staff.id);
  return { code };
}

export async function setStaffActive(id: string, active: boolean): Promise<{ id: string; active: boolean }> {
  const staff = await findStaff(id);
  const db = await getDb();
  await db.update(adminUsers).set({ active, updatedAt: new Date() }).where(eq(adminUsers.id, staff.id));
  if (!active) await destroyAllForSubject("admin", staff.id); // instant revocation
  return { id: staff.id, active };
}
