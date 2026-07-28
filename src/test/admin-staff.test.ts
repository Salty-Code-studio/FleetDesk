import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { adminUsers, sessions } from "@/lib/db/schema";
import { createSession } from "@/lib/auth/sessions";
import {
  createStaff, listStaff, regenerateStaffCode, setStaffActive, hashStaffCode,
} from "@/lib/admin/staff";

let db: Awaited<ReturnType<typeof getDb>>;

beforeAll(async () => {
  db = await getDb();
  await runMigrations();
});

describe("staff account management", () => {
  it("creates a staff member with a one-time 6-digit code stored only as a hash", async () => {
    const created = await createStaff("Maya");
    expect(created.code).toMatch(/^\d{6}$/);
    expect(created.name).toBe("Maya");
    const [row] = await db.select().from(adminUsers).where(eq(adminUsers.id, created.id));
    expect(row!.role).toBe("staff");
    expect(row!.name).toBe("Maya");
    expect(row!.active).toBe(true);
    // Demo-admin pattern: MFA "enrolled" so the mandatory-MFA guard admits the
    // session; the throwaway secret is never verified.
    expect(row!.mfaEnabled).toBe(true);
    expect(row!.totpSecretEnc).not.toBeNull();
    expect(row!.loginCodeHash).toBe(hashStaffCode(created.code));
    expect(row!.loginCodeHash).not.toContain(created.code);
    expect(row!.email).toBe(`staff-${created.id}@staff.local`);
  });

  it("lists staff accounts only, owners excluded", async () => {
    const [owner] = await db.insert(adminUsers).values({
      email: "roster-owner@fleetdesk.app", passwordHash: "x",
    }).returning();
    const staff = await createStaff("Rey");
    const roster = await listStaff();
    const ids = roster.map((r) => r.id);
    expect(ids).toContain(staff.id);
    expect(ids).not.toContain(owner!.id);
    const rey = roster.find((r) => r.id === staff.id)!;
    expect(rey).toMatchObject({ name: "Rey", active: true });
    expect(rey.createdAt).toBeInstanceOf(Date);
  });

  it("regenerating replaces the code and revokes existing sessions", async () => {
    const created = await createStaff("Nia");
    await createSession({ subjectType: "admin", subjectId: created.id });
    const regen = await regenerateStaffCode(created.id);
    expect(regen.code).toMatch(/^\d{6}$/);
    const [row] = await db.select().from(adminUsers).where(eq(adminUsers.id, created.id));
    expect(row!.loginCodeHash).toBe(hashStaffCode(regen.code));
    // The uniqueness check clashes against the row's own current hash, so the
    // regenerated code is guaranteed different from the old one.
    expect(row!.loginCodeHash).not.toBe(hashStaffCode(created.code));
    expect(row!.codeFailedAttempts).toBe(0);
    expect(row!.codeLockedUntil).toBeNull();
    const live = await db.select().from(sessions).where(eq(sessions.subjectId, created.id));
    expect(live).toHaveLength(0);
  });

  it("deactivating revokes sessions, reactivating restores access flag", async () => {
    const created = await createStaff("Odin");
    await createSession({ subjectType: "admin", subjectId: created.id });
    const off = await setStaffActive(created.id, false);
    expect(off).toEqual({ id: created.id, active: false });
    const live = await db.select().from(sessions).where(eq(sessions.subjectId, created.id));
    expect(live).toHaveLength(0);
    const on = await setStaffActive(created.id, true);
    expect(on).toEqual({ id: created.id, active: true });
  });

  it("refuses to manage an owner account through the staff API", async () => {
    const [owner] = await db.insert(adminUsers).values({
      email: "protected-owner@fleetdesk.app", passwordHash: "x",
    }).returning();
    await expect(regenerateStaffCode(owner!.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(setStaffActive(owner!.id, false)).rejects.toMatchObject({ code: "not_found" });
  });
});
