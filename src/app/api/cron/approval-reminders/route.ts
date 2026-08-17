import { NextResponse } from "next/server";
import { env } from "@/env";
import { logger } from "@/lib/logger";
import { runApprovalReminders } from "@/lib/approval/reminders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/cron/approval-reminders: hourly nudge for unanswered desk-mode
 *  approvals plus a janitor for requests decided elsewhere. CRON_SECRET
 *  guarded like every cron. */
export async function GET(req: Request): Promise<NextResponse> {
  const auth = req.headers.get("authorization");
  if (!env.CRON_SECRET || auth !== `Bearer ${env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await runApprovalReminders();
  logger.info("cron_approval_reminders", result);
  return NextResponse.json({ ok: true, ...result });
}
