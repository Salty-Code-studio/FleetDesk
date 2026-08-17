import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseJsonBody } from "@/lib/http/validate";
import { enforceRateLimit } from "@/lib/http/rate-limit";
import { enforceOrigin } from "@/lib/auth/csrf";
import { applyDecisionByToken } from "@/lib/approval/core";
import { broadcastDecision } from "@/lib/approval/broadcast";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  token: z.string().min(10).max(200),
  action: z.enum(["confirm", "decline"]),
}).strict();

/** POST /api/approval/decide: the email review page's real mutation. POST on
 *  purpose: mail scanners follow GET links and must never decide a booking. */
export const POST = withRoute(async (req) => {
  enforceOrigin(req);
  await enforceRateLimit(req, "global", "approval");
  const { token, action } = await parseJsonBody(req, BodySchema);
  const result = await applyDecisionByToken(token, action);
  if (result.outcome === "confirmed" || result.outcome === "declined") {
    await broadcastDecision(result.request.id);
  }
  return json({
    outcome: result.outcome,
    decidedBy: result.outcome === "already_handled" ? result.decidedBy : undefined,
  }, req);
});
