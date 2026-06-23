import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";

describe("db factory", () => {
  it("connects via PGlite and answers a query", async () => {
    const db = await getDb();
    const result = (await db.execute(sql`select 1 as ok`)) as
      | { rows: Record<string, unknown>[] }
      | Record<string, unknown>[];
    // PGlite returns { rows }, postgres-js returns the row array directly
    const rows = Array.isArray(result) ? result : result.rows;
    expect(rows[0]).toEqual({ ok: 1 });
  });
});
