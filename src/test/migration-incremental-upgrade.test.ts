import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";

/**
 * Incremental-upgrade regression guard for the enum wave (0015/0016).
 *
 * Fresh-install CI applies EVERY migration in a single transaction, so a newly
 * ADDed enum value is usable in the same transaction that CREATEd its type — the
 * check Postgres relaxes only for same-transaction types. That path is green
 * even when a wave migration is unsafe.
 *
 * Real deployed tenants are different: they are parked at an older committed
 * schema, so a later `npm run db:migrate` runs ONLY the new migrations, in their
 * own transaction, against a type that was committed earlier. `ALTER TYPE ... ADD
 * VALUE` followed by USING that value in the same transaction is then rejected
 * with Postgres 55P04 "unsafe use of new value". This test reproduces that
 * populated-tenant path so the bug can never come back unnoticed.
 */

const DRIZZLE_DIR = path.resolve(process.cwd(), "drizzle");

function rows(result: unknown): Record<string, unknown>[] {
  // PGlite returns { rows }, postgres-js returns the row array directly.
  return Array.isArray(result) ? result : (result as { rows: Record<string, unknown>[] }).rows;
}

/**
 * Copy journal entries 0000..upToIdx (and their SQL files) into a throwaway
 * migrations folder, so drizzle's migrator applies exactly that prefix and
 * COMMITS it — standing in for a tenant already deployed at schema `upToIdx`.
 */
function buildPrefixFolder(upToIdx: number): string {
  const journal = JSON.parse(
    fs.readFileSync(path.join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8"),
  ) as { entries: { idx: number; tag: string }[] };
  const kept = journal.entries.filter((e) => e.idx <= upToIdx);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleetdesk-mig-"));
  fs.mkdirSync(path.join(dir, "meta"));
  fs.writeFileSync(
    path.join(dir, "meta", "_journal.json"),
    JSON.stringify({ ...journal, entries: kept }),
  );
  for (const e of kept) {
    fs.copyFileSync(path.join(DRIZZLE_DIR, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
  }
  return dir;
}

describe("incremental migration upgrade on a populated DB", () => {
  it("applies the wave (0015+) on a tenant already at 0014 with committed bookings data (no 55P04)", async () => {
    const db = await getDb();
    const { migrate } = await import("drizzle-orm/pglite/migrator");

    // Phase 1: bring a fresh DB up to schema 0014 and commit it.
    const prefix = buildPrefixFolder(14);
    try {
      await migrate(db as never, { migrationsFolder: prefix });

      // Seed a representative bookings row so booking_status has COMMITTED data
      // before the enum is reshaped in the second migrate() call. This also
      // exercises the value-preserving USING cast in the rewritten 0015.
      await db.execute(sql`
        INSERT INTO "vehicles" ("slug", "plate", "class", "name", "seats", "transmission", "doors", "price_day_cents", "price_week_cents", "price_month_cents")
        VALUES ('mig-car', 'PL-MIG', 'SUV', 'Mig Car', 5, 'Automatic', 5, 5800, 34800, 118000)`);
      await db.execute(sql`
        INSERT INTO "customers" ("email", "email_verified") VALUES ('mig@t.com', false)`);
      await db.execute(sql`
        INSERT INTO "bookings"
          ("vehicle_id", "customer_id", "start_date", "end_date", "buffer_end_date", "status", "price_breakdown", "payment_option", "accepted_policy_version", "accepted_at", "idempotency_key")
        SELECT v."id", c."id", DATE '2026-07-01', DATE '2026-07-08', DATE '2026-07-09', 'confirmed',
               '{"totalCents":10000}'::jsonb, 'reservation_fee', 1, now(), 'mig-key-1'
        FROM "vehicles" v, "customers" c
        WHERE v."slug" = 'mig-car' AND c."email" = 'mig@t.com'`);

      // Phase 2: apply the remaining wave migrations (0015..end) in their OWN
      // transaction — the deployed-tenant path. The buggy ADD VALUE + predicate
      // combination throws 55P04 here; the type-swap rewrite must not.
      await expect(
        migrate(db as never, { migrationsFolder: DRIZZLE_DIR }),
      ).resolves.toBeUndefined();

      // The seeded row survived the enum swap unchanged...
      const before = rows(
        await db.execute(sql`SELECT "status"::text AS status FROM "bookings" WHERE "idempotency_key" = 'mig-key-1'`),
      );
      expect(before[0]!.status).toBe("confirmed");

      // ...and 'picked_up' is a usable value on the upgraded type.
      await db.execute(sql`UPDATE "bookings" SET "status" = 'picked_up' WHERE "idempotency_key" = 'mig-key-1'`);
      const after = rows(
        await db.execute(sql`SELECT "status"::text AS status FROM "bookings" WHERE "idempotency_key" = 'mig-key-1'`),
      );
      expect(after[0]!.status).toBe("picked_up");
    } finally {
      fs.rmSync(prefix, { recursive: true, force: true });
    }
  });
});
