import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { adminUsers, auditLog } from "@/lib/db/schema";
import { createStaff, setStaffActive, hashStaffCode } from "@/lib/admin/staff";
import { loginStaff, STAFF_LOCK_THRESHOLD, STAFF_LOCK_SECONDS } from "@/lib/auth/staff-login";

let db: Awaited<ReturnType<typeof getDb>>;

beforeAll(async () => {
  db = await getDb();
  await runMigrations();
});

/** A code guaranteed to match no account right now. */
async function wrongCode(): Promise<string> {
  for (let i = 0; i < 1_000_000; i++) {
    const c = String(i).padStart(6, "0");
    const [hit] = await db.select({ id: adminUsers.id }).from(adminUsers)
      .where(eq(adminUsers.loginCodeHash, hashStaffCode(c)));
    if (!hit) return c;
  }
  throw new Error("no unused code found");
}

describe("staff code login", () => {
  it("signs in with a correct code and resets the failure counters", async () => {
    const created = await createStaff("Maya");
    await loginStaff(await wrongCode()); // one collective failure first
    const result = await loginStaff(created.code);
    expect(result).toEqual({ ok: true, adminId: created.id, name: "Maya" });
    const [row] = await db.select().from(adminUsers).where(eq(adminUsers.id, created.id));
    expect(row!.codeFailedAttempts).toBe(0);
    expect(row!.codeLockedUntil).toBeNull();
  });

  it("rejects a wrong code with the same generic result as any other failure", async () => {
    expect(await loginStaff(await wrongCode())).toEqual({ ok: false });
  });

  it("rejects a deactivated staff member's correct code", async () => {
    const created = await createStaff("Rey");
    await setStaffActive(created.id, false);
    expect(await loginStaff(created.code)).toEqual({ ok: false });
  });

  it("locks the staff code path after 5 straight failures and releases after 15 minutes", async () => {
    // Normalize counters so earlier tests cannot skew the threshold.
    await db.update(adminUsers).set({ codeFailedAttempts: 0, codeLockedUntil: null });
    const created = await createStaff("Lock");
    const bad = await wrongCode();
    const t0 = new Date();
    for (let i = 0; i < STAFF_LOCK_THRESHOLD; i++) {
      expect((await loginStaff(bad, {}, t0)).ok).toBe(false);
    }
    // Locked: even the CORRECT code is rejected inside the window.
    expect((await loginStaff(created.code, {}, t0)).ok).toBe(false);
    // After the window the correct code works again (counters were reset when
    // the lock engaged).
    const later = new Date(t0.getTime() + (STAFF_LOCK_SECONDS + 1) * 1000);
    const result = await loginStaff(created.code, {}, later);
    expect(result.ok).toBe(true);
  });

  it("keeps the lock shared: a login success on one account doesn't exempt it from a lock the rest just tripped", async () => {
    // Normalize counters so earlier tests cannot skew the threshold.
    await db.update(adminUsers).set({ codeFailedAttempts: 0, codeLockedUntil: null });
    const a = await createStaff("Zola");
    const b = await createStaff("Milo");
    const bad = await wrongCode();
    const t0 = new Date();

    // One short of the threshold: every active row (including A and B) is
    // now sitting at STAFF_LOCK_THRESHOLD - 1 failed attempts.
    for (let i = 0; i < STAFF_LOCK_THRESHOLD - 1; i++) {
      expect((await loginStaff(bad, {}, t0)).ok).toBe(false);
    }

    // A successful login resets counters/lock on ONLY the matched row (A).
    const success = await loginStaff(a.code, {}, t0);
    expect(success).toEqual({ ok: true, adminId: a.id, name: "Zola" });

    // One more collective failure trips the lock on every row still at the
    // threshold (B and any other staff row) but NOT on A's row, which was
    // just reset to 0. The lockout is only genuinely shared if that doesn't
    // matter: A's own code must be rejected too, or an attacker gets extra
    // guesses by interleaving against whichever account logged in most
    // recently.
    expect((await loginStaff(bad, {}, t0)).ok).toBe(false);
    expect((await loginStaff(a.code, {}, t0)).ok).toBe(false);
    expect((await loginStaff(b.code, {}, t0)).ok).toBe(false);
  });

  it("audit-logs failures, lockout engagement, and rejections", async () => {
    const rows = await db.select().from(auditLog);
    const actions = new Set(rows.map((r) => r.action));
    expect(actions).toContain("admin.staff_login_failed");
    expect(actions).toContain("admin.staff_lockout_engaged");
    expect(actions).toContain("admin.staff_login_rejected_locked");
    expect(actions).toContain("admin.staff_login_rejected_inactive");
  });
});
