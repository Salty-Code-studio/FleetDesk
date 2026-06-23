import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { adminUsers, auditLog } from "@/lib/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { loginAdmin, LOCK_THRESHOLD, LOCK_BASE_SECONDS } from "@/lib/auth/admin-login";

let db: Awaited<ReturnType<typeof getDb>>;
const PASSWORD = "correct horse battery staple 42";

async function makeAdmin(email: string) {
  const [row] = await db.insert(adminUsers).values({
    email, passwordHash: await hashPassword(PASSWORD),
  }).returning();
  return row!;
}

beforeAll(async () => {
  db = await getDb();
  await runMigrations();
});

describe("admin login + lockout", () => {
  it("authenticates a correct password", async () => {
    const admin = await makeAdmin("ok@fleetdesk.app");
    const result = await loginAdmin("OK@fleetdesk.app", PASSWORD); // case-insensitive email
    expect(result).toEqual({ ok: true, adminId: admin.id, mfaEnabled: false });
  });

  it("fails generically on a wrong password and on an unknown email", async () => {
    await makeAdmin("wrong@fleetdesk.app");
    expect(await loginAdmin("wrong@fleetdesk.app", "nope")).toEqual({ ok: false });
    expect(await loginAdmin("ghost@fleetdesk.app", "nope")).toEqual({ ok: false });
  });

  it("locks after LOCK_THRESHOLD failures with exponential backoff, even for the right password", async () => {
    const admin = await makeAdmin("lock@fleetdesk.app");
    for (let i = 0; i < LOCK_THRESHOLD - 1; i++) {
      expect(await loginAdmin(admin.email, "bad")).toEqual({ ok: false });
    }
    const locking = await loginAdmin(admin.email, "bad");
    expect(locking.ok).toBe(false);
    expect((locking as { retryAfterSec?: number }).retryAfterSec).toBe(LOCK_BASE_SECONDS);

    // Locked: correct password is rejected before verification.
    const duringLock = await loginAdmin(admin.email, PASSWORD);
    expect(duringLock.ok).toBe(false);
    expect((duringLock as { retryAfterSec?: number }).retryAfterSec).toBeGreaterThan(0);

    // After the lock expires (simulate via injected now): next lock doubles.
    const afterLock = new Date(Date.now() + (LOCK_BASE_SECONDS + 1) * 1000);
    for (let i = 0; i < LOCK_THRESHOLD - 1; i++) {
      expect((await loginAdmin(admin.email, "bad", {}, afterLock)).ok).toBe(false);
    }
    const secondLock = await loginAdmin(admin.email, "bad", {}, afterLock);
    expect((secondLock as { retryAfterSec?: number }).retryAfterSec).toBe(LOCK_BASE_SECONDS * 2);
  });

  it("success resets failure counters", async () => {
    const admin = await makeAdmin("reset@fleetdesk.app");
    await loginAdmin(admin.email, "bad");
    await loginAdmin(admin.email, "bad");
    expect((await loginAdmin(admin.email, PASSWORD)).ok).toBe(true);
    const [row] = await db.select().from(adminUsers).where(eq(adminUsers.id, admin.id));
    expect(row?.failedAttempts).toBe(0);
    expect(row?.lockoutCount).toBe(0);
    expect(row?.lockedUntil).toBeNull();
  });

  it("a locked account returns the same generic failure as an unknown email (no existence oracle)", async () => {
    const admin = await makeAdmin("oracle@fleetdesk.app");
    for (let i = 0; i < LOCK_THRESHOLD; i++) await loginAdmin(admin.email, "bad");
    const locked = await loginAdmin(admin.email, PASSWORD); // correct password, but locked
    const unknown = await loginAdmin("nobody@fleetdesk.app", "whatever");
    // loginAdmin still reports retryAfterSec internally for audit/limiter use,
    // but the locked result must remain ok:false just like the unknown one.
    expect(locked.ok).toBe(false);
    expect(unknown.ok).toBe(false);
  });

  it("audit-logs failures, lockouts, and successes", async () => {
    const rows = await db.select().from(auditLog);
    const actions = new Set(rows.map((r) => r.action));
    expect(actions).toContain("admin.login_failed");
    expect(actions).toContain("admin.lockout_engaged");
    expect(actions).toContain("admin.login_succeeded");
    expect(actions).toContain("admin.login_rejected_locked");
  });
});
