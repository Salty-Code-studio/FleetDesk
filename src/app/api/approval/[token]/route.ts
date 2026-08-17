import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseParams } from "@/lib/http/validate";
import { enforceRateLimit } from "@/lib/http/rate-limit";
import { Errors } from "@/lib/http/errors";
import { getApprovalSummary } from "@/lib/approval/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// min(1) only: this must not become a second "is this shaped like a token"
// oracle. Any string that isn't a real, unexpired token falls through to
// getApprovalSummary and comes back 404 via the SAME path as a well-formed
// but wrong token, so a guesser learns nothing from the status code. max(200)
// stays as a cheap abuse guard against absurdly long input.
const ParamsSchema = z.object({ token: z.string().min(1).max(200) });

/** GET /api/approval/:token, token-gated read for the email review page. */
export const GET = withRoute(async (req, { params }) => {
  await enforceRateLimit(req, "global", "approval");
  const { token } = parseParams(await params, ParamsSchema);
  const summary = await getApprovalSummary(token);
  if (!summary) throw Errors.notFound("This approval link is not valid");
  return json({
    status: summary.request.status,
    decidedBy: summary.request.decidedBy,
    message: summary.message,
  }, req);
});
