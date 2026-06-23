/**
 * Database client factory — one `getDb()` for the whole app.
 *
 * Two drivers behind one interface (selected by DATABASE_URL scheme):
 *   - pglite://   real Postgres compiled to WASM, in-process. Zero install,
 *                 used for local dev and tests. Loads btree_gist so the
 *                 bookings exclusion constraint behaves exactly like prod.
 *   - postgres:// postgres-js against Supabase / Neon (or any Postgres) in
 *                 production. `prepare: false` because the managed pooled URLs
 *                 (Supabase Supavisor / Neon pgbouncer, transaction mode) break
 *                 named prepared statements. Point DATABASE_URL at the
 *                 transaction pooler (Supabase :6543) for serverless runtime.
 *
 * SECURITY: all access goes through Drizzle's typed builder — parameterized
 * queries only (OWASP A03:2021). Never interpolate user input into raw SQL.
 */
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { env, isProd } from "@/env";
import * as schema from "./schema";

/** The common Postgres interface both drivers satisfy. Using one concrete type
 *  (instead of a union) keeps builder methods like `.returning()` callable. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * Whether a postgres:// connection must negotiate TLS. Managed Postgres
 * (Supabase, Neon) mandates TLS; only a bare localhost/loopback host is exempt.
 * Keyed on the URL HOST, not NODE_ENV — so running migrations against a remote
 * database from a laptop (NODE_ENV=development) still uses TLS instead of being
 * rejected. An explicit `?sslmode=disable` opts out (local Docker Postgres).
 */
export function shouldUseSsl(url: string): boolean {
  try {
    const u = new URL(url);
    if (/(^|[?&])sslmode=disable([&]|$)/.test(u.search)) return false;
    const host = u.hostname.replace(/^\[|\]$/g, ""); // IPv6 hostnames parse WITH brackets
    return !(host === "localhost" || host === "127.0.0.1" || host === "::1");
  } catch {
    return isProd;
  }
}

let dbPromise: Promise<Db> | null = null;
let closeClient: (() => Promise<void>) | null = null;

async function createDb(): Promise<Db> {
  if (env.DATABASE_URL.startsWith("pglite://")) {
    const { PGlite } = await import("@electric-sql/pglite");
    const { btree_gist } = await import("@electric-sql/pglite/contrib/btree_gist");
    const { drizzle } = await import("drizzle-orm/pglite");
    const target = env.DATABASE_URL.slice("pglite://".length);
    // NOTE: must use the options-object form — new PGlite(undefined, opts)
    // silently ignores opts, and the btree_gist extension never registers.
    const client = new PGlite({
      ...(target === "memory" ? {} : { dataDir: target }),
      extensions: { btree_gist },
    });
    closeClient = () => client.close();
    return drizzle(client, { schema }) as unknown as Db;
  }
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const postgres = (await import("postgres")).default;
  const client = postgres(env.DATABASE_URL, {
    max: 10,
    prepare: false,
    connect_timeout: 10, // fail fast instead of hanging the health probe
    // TLS is NOT postgres-js's default. Require it for any remote host so PII
    // and credentials never cross the network in cleartext (fort:
    // secrets-management, encryption-data-protection). Supabase and Neon enforce
    // TLS anyway; this also covers "or any Postgres" and the laptop-migrate path.
    ...(shouldUseSsl(env.DATABASE_URL) ? { ssl: "require" as const } : {}),
  });
  closeClient = () => client.end({ timeout: 5 });
  return drizzle(client, { schema }) as unknown as Db;
}

export function getDb(): Promise<Db> {
  // If init rejects, clear the singleton so a transient driver/WASM-load failure
  // can be retried on the next call instead of caching the rejection for the
  // life of the process.
  dbPromise ??= createDb().catch((e: unknown) => {
    dbPromise = null;
    throw e;
  });
  return dbPromise;
}

/** Close the underlying connection/pool (scripts, tests, graceful shutdown). */
export async function closeDb(): Promise<void> {
  if (dbPromise) await dbPromise.catch(() => undefined);
  if (closeClient) await closeClient();
  dbPromise = null;
  closeClient = null;
}

// Graceful-shutdown handle for instrumentation.ts, which must NOT import this
// module (webpack would drag postgres/PGlite into the instrumentation bundle,
// where node built-ins like `net` don't resolve).
(globalThis as Record<string, unknown>).__texCloseDb = closeDb;
