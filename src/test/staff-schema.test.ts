import { describe, it, expect, beforeAll } from "vitest";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { adminUsers } from "@/lib/db/schema";

let db: Awaited<ReturnType<typeof getDb>>;

beforeAll(async () => {
  db = await getDb();
  await runMigrations();
});

describe("admin_users staff columns", () => {
  it("stores staff login fields with correct defaults", async () => {
    const [row] = await db.insert(adminUsers).values({
      email: "staff-schema@staff.local",
      passwordHash: "x",
      role: "staff",
      name: "Maya",
      loginCodeHash: "abc123",
    }).returning();
    expect(row!.name).toBe("Maya");
    expect(row!.loginCodeHash).toBe("abc123");
    expect(row!.codeFailedAttempts).toBe(0);
    expect(row!.codeLockedUntil).toBeNull();
    expect(row!.active).toBe(true);
  });

  it("leaves owner rows unaffected: active defaults true, code fields null", async () => {
    const [row] = await db.insert(adminUsers).values({
      email: "owner-schema@fleetdesk.app",
      passwordHash: "x",
    }).returning();
    expect(row!.active).toBe(true);
    expect(row!.loginCodeHash).toBeNull();
    expect(row!.name).toBeNull();
  });
});
