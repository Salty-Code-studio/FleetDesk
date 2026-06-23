import { sql } from "drizzle-orm";
import { withRoute } from "@/lib/http/handler";
import { json, noContent } from "@/lib/http/respond";
import { getDb } from "@/lib/db/client";
import { logger } from "@/lib/logger";

/**
 * GET /api/health — liveness/readiness probe.
 *
 * Returns the MINIMUM needed by an orchestrator to decide if the instance is
 * healthy. Deliberately leaks NO build/version/dependency detail (information-
 * disclosure avoidance): the body says only ok/degraded; detail goes to logs.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // never cache health

export const GET = withRoute(async (req) => {
  try {
    const db = await getDb();
    await db.execute(sql`select 1`);
    return json({ status: "ok", db: true }, req);
  } catch (error) {
    logger.error("health: database ping failed", { error: (error as Error).message });
    return json({ status: "degraded", db: false }, req, { status: 503 });
  }
});

// Explicitly answer preflight at the route level too (middleware also handles it).
export const OPTIONS = withRoute(async (req) => noContent(req));
