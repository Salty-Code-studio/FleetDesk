import { describe, it, expect, beforeAll } from "vitest";
import { runMigrations } from "@/lib/db/migrate";
import { getDb } from "@/lib/db/client";
import { auditLog, adminUsers } from "@/lib/db/schema";
import { listAudit } from "@/lib/admin/audit";

beforeAll(async () => {
  await runMigrations();
  const db = await getDb();
  for (let i = 0; i < 5; i++) {
    await db.insert(auditLog).values({ actor: "system", action: `test.event_${i}`, entity: "test" });
  }
});

describe("audit viewer", () => {
  it("returns rows newest-first and respects the limit", async () => {
    const rows = await listAudit({ limit: 3 });
    expect(rows.length).toBe(3);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1]!.createdAt.getTime()).toBeGreaterThanOrEqual(rows[i]!.createdAt.getTime());
    }
  });

  it("clamps the limit via the query schema", async () => {
    const { AuditQuerySchema } = await import("@/lib/admin/audit");
    expect(AuditQuerySchema.safeParse({ limit: 9999 }).success).toBe(false);
    expect(AuditQuerySchema.parse({}).limit).toBe(50);
  });

  it("filters by action", async () => {
    const rows = await listAudit({ limit: 50, action: "test.event_1" });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.action).toBe("test.event_1");
  });

  it("resolves admin actors to a person label, name first then email", async () => {
    const db = await getDb();
    const [named] = await db.insert(adminUsers).values({
      email: "staff-label@staff.local", passwordHash: "x", role: "staff", name: "Maya",
    }).returning();
    const [unnamed] = await db.insert(adminUsers).values({
      email: "owner-label@fleetdesk.app", passwordHash: "x",
    }).returning();
    await db.insert(auditLog).values({ actor: named!.id, action: "test.labeled", entity: "test" });
    await db.insert(auditLog).values({ actor: unnamed!.id, action: "test.labeled", entity: "test" });
    const rows = await listAudit({ limit: 10, action: "test.labeled" });
    const labels = rows.map((r) => r.actorLabel).sort();
    expect(labels).toEqual(["Maya", "owner-label@fleetdesk.app"]);
    // Non-admin actors fall back to the raw actor string.
    const system = await listAudit({ limit: 5, action: "test.event_0" });
    expect(system[0]!.actorLabel).toBe("system");
  });
});
