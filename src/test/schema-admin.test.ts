import { describe, it, expect, beforeAll } from "vitest";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { adminUsers, policies, auditLog } from "@/lib/db/schema";
import { expectReject } from "./util";

let db: Awaited<ReturnType<typeof getDb>>;

beforeAll(async () => {
  db = await getDb();
  await runMigrations();
});

describe("admin, policies, logs schema", () => {
  it("creates an admin user with safe defaults", async () => {
    const [row] = await db.insert(adminUsers).values({
      email: "owner@fleetdesk.app",
      passwordHash: "$argon2id$placeholder-hash-not-a-real-credential",
    }).returning();
    expect(row?.role).toBe("owner");
    expect(row?.mfaEnabled).toBe(false);
    expect(row?.failedAttempts).toBe(0);
    expect(row?.lockedUntil).toBeNull();
  });

  it("keeps policy versions per type and rejects duplicates", async () => {
    await db.insert(policies).values({ type: "rental_terms", version: 1, body: "v1" });
    await db.insert(policies).values({ type: "rental_terms", version: 2, body: "v2" });
    await db.insert(policies).values({ type: "privacy", version: 1, body: "p1" });
    await expectReject(
      db.insert(policies).values({ type: "rental_terms", version: 2, body: "dup" }),
      /unique|duplicate|policies_type_version/i,
    );
  });

  it("writes an audit entry", async () => {
    const [row] = await db.insert(auditLog).values({
      actor: "system", action: "test.write", entity: "test", after: { ok: true },
    }).returning();
    expect(row?.createdAt).toBeInstanceOf(Date);
  });
});
