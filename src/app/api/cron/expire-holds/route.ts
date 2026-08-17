import { NextResponse } from "next/server";
import { env, isDeskMode } from "@/env";
import { logger } from "@/lib/logger";
import { expireStaleHolds } from "@/lib/payments/holds";
import { sweepInspectionMedia, sweepDriverLicenses } from "@/lib/admin/inspections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/cron/expire-holds — daily maintenance, called by Vercel Cron (see
 * vercel.json). Authenticated by the CRON_SECRET bearer token; refuses to run
 * without it. Three chores: cancel stale unpaid pending holds, purge
 * inspection media past the licenseRetentionDays window (wave 06), and purge
 * driver_licenses rows past their own retainUntil timer (bug fix: nothing
 * consumed that timer before, so licence PII was retained forever).
 */
export async function GET(req: Request): Promise<NextResponse> {
  const auth = req.headers.get("authorization");
  if (!env.CRON_SECRET || auth !== `Bearer ${env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Desk mode has no online checkout to abandon; expiring "unpaid" pending
  // holds would cancel every real desk booking after 30 minutes.
  const cancelled = isDeskMode ? 0 : await expireStaleHolds(30);
  const mediaPurged = await sweepInspectionMedia();
  const licensesPurged = await sweepDriverLicenses();
  logger.info("cron_expire_holds", { cancelled, mediaPurged, licensesPurged });
  return NextResponse.json({ ok: true, cancelled, mediaPurged, licensesPurged });
}
