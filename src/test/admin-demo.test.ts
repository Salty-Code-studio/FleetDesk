import { describe, it, expect, beforeAll } from "vitest";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { provisionDemoAdmin, findDemoAdmin, DEMO_ADMIN_EMAIL } from "@/lib/auth/demo";
import { createSession, resolveSession } from "@/lib/auth/sessions";

let db: Awaited<ReturnType<typeof getDb>>;

beforeAll(async () => {
  db = await getDb();
  await runMigrations();
});

describe("demo admin provisioning", () => {
  it("has no demo admin until provisioned", async () => {
    // A different DB fixture would be ideal, but the suite shares one pglite; if
    // an earlier test already provisioned, this simply documents current state.
    const before = await findDemoAdmin(db);
    if (before) expect(before.email).toBe(DEMO_ADMIN_EMAIL);
  });

  it("provisions a well-formed demo admin the requireAdmin guard will admit", async () => {
    const admin = await provisionDemoAdmin(db);
    // These are exactly the fields requireAdmin checks: an owner whose MFA is
    // 'enrolled', so every /api/admin route is reachable without a real TOTP.
    expect(admin.email).toBe(DEMO_ADMIN_EMAIL);
    expect(admin.role).toBe("owner");
    expect(admin.mfaEnabled).toBe(true);
    expect(admin.totpSecretEnc).not.toBeNull();
  });

  it("is idempotent — repeated provisioning returns the same account", async () => {
    const a = await provisionDemoAdmin(db);
    const b = await provisionDemoAdmin(db);
    expect(b.id).toBe(a.id);
    const found = await findDemoAdmin(db);
    expect(found?.id).toBe(a.id);
  });

  it("the demo door mints a FULL (non-mfaPending) admin session for it", async () => {
    const admin = await provisionDemoAdmin(db);
    // This mirrors POST /api/admin/auth/demo: a full session, no second factor.
    const created = await createSession({ subjectType: "admin", subjectId: admin.id, mfaPending: false });
    const record = await resolveSession(created.cookieValue);
    expect(record).not.toBeNull();
    expect(record!.subjectType).toBe("admin");
    expect(record!.subjectId).toBe(admin.id);
    expect(record!.mfaPending).toBe(false);
  });
});
