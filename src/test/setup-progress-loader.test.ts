import { describe, it, expect, beforeAll } from "vitest";
import { runMigrations } from "@/lib/db/migrate";
import { getSetupProgress } from "@/lib/admin/setup-progress-loader";

describe("getSetupProgress loader", () => {
  beforeAll(async () => { await runMigrations(); });
  it("returns the nine-item shape from the database", async () => {
    const p = await getSetupProgress();
    expect(p.total).toBe(9);
    expect(p.items).toHaveLength(9);
    expect(p.items.find((i) => i.key === "rates")?.done).toBe(false);
    expect(p.pct).toBe(Math.round((p.done / 9) * 100));
  });
});
