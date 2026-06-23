import { NextResponse } from "next/server";
import { env } from "@/env";
import { logger } from "@/lib/logger";
import { expireStaleHolds } from "@/lib/payments/holds";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/cron/expire-holds — cancel stale unpaid pending holds. Called on a
 * schedule by Vercel Cron (see vercel.json). Authenticated by the CRON_SECRET
 * bearer token Vercel sends; refuses to run without it.
 */
export async function GET(req: Request): Promise<NextResponse> {
  const auth = req.headers.get("authorization");
  if (!env.CRON_SECRET || auth !== `Bearer ${env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const cancelled = await expireStaleHolds(30); // holds older than 30 min, unpaid
  logger.info("cron_expire_holds", { cancelled });
  return NextResponse.json({ ok: true, cancelled });
}
