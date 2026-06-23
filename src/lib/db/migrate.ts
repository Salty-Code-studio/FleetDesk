/**
 * Migration runner — applies the SQL files in ./drizzle to whichever driver
 * DATABASE_URL selects. Used by tests (into PGlite) and by `npm run db:migrate`.
 */
import path from "node:path";
import { env } from "@/env";
import { getDb, shouldUseSsl } from "./client";

const migrationsFolder = path.resolve(process.cwd(), "drizzle");

export async function runMigrations(): Promise<void> {
  // PGlite (dev/test) migrates through the shared in-process client.
  if (env.DATABASE_URL.startsWith("pglite://")) {
    const db = await getDb();
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    await migrate(db as never, { migrationsFolder });
    return;
  }

  // Real Postgres: prefer the DIRECT/session connection for DDL when provided
  // (Supabase runs migrations on the direct :5432, not the transaction pooler
  // :6543). Use a dedicated single-connection client so the migration never
  // shares the runtime pool and the socket is closed when we're done.
  const migrationUrl = env.DATABASE_MIGRATION_URL || env.DATABASE_URL;
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const postgres = (await import("postgres")).default;
  const sql = postgres(migrationUrl, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    ...(shouldUseSsl(migrationUrl) ? { ssl: "require" as const } : {}),
  });
  try {
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    await migrate(drizzle(sql) as never, { migrationsFolder });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
