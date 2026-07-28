import { NextResponse } from "next/server";
import { env } from "@/env";
import { logger } from "@/lib/logger";
import { expireStaleHolds } from "@/lib/payments/holds";
import { sweepInspectionMedia } from "@/lib/admin/inspections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/cron/expire-holds — daily maintenance, called by Vercel Cron (see
 * vercel.json). Authenticated by the CRON_SECRET bearer token; refuses to run
 * without it. Two chores: cancel stale unpaid pending holds, and purge
 * inspection media past the licenseRetentionDays window (wave 06).
 */
export async function GET(req: Request): Promise<NextResponse> {
  const auth = req.headers.get("authorization");
  if (!env.CRON_SECRET || auth !== `Bearer ${env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const cancelled = await expireStaleHolds(30); // holds older than 30 min, unpaid
  const mediaPurged = await sweepInspectionMedia();
  logger.info("cron_expire_holds", { cancelled, mediaPurged });
  return NextResponse.json({ ok: true, cancelled, mediaPurged });
}
