import { NextResponse } from "next/server";
import { env } from "@/env";
import { logger } from "@/lib/logger";
import { runComplianceAlerts } from "@/lib/admin/compliance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/cron/compliance-alerts (wave 03): daily insurance/inspection expiry
 * check. Called on a schedule by Vercel Cron (see vercel.json). Authenticated
 * by the CRON_SECRET bearer token Vercel sends; refuses to run without it.
 */
export async function GET(req: Request): Promise<NextResponse> {
  const auth = req.headers.get("authorization");
  if (!env.CRON_SECRET || auth !== `Bearer ${env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { fired } = await runComplianceAlerts();
  logger.info("cron_compliance_alerts", { fired });
  return NextResponse.json({ ok: true, fired });
}
