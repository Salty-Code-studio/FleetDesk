import { describe, it, expect, beforeAll } from "vitest";
import { runMigrations } from "@/lib/db/migrate";
import { getDb } from "@/lib/db/client";
import { auditLog } from "@/lib/db/schema";
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
});
