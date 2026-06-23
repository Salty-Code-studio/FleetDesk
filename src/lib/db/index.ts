/** THE data layer entry point: `@/lib/db` means the Drizzle Postgres client. */
export { getDb, closeDb, type Db } from "./client";
export { runMigrations } from "./migrate";
export * as schema from "./schema";
