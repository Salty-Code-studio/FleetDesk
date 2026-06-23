import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseParams } from "@/lib/http/validate";
import { Errors } from "@/lib/http/errors";
import { enforceRateLimit } from "@/lib/http/rate-limit";
import { publicPolicy } from "@/lib/booking/public";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ type: z.enum(["rental_terms", "cancellation", "privacy"]) });

/** GET /api/policies/[type] — the current published version, public. */
export const GET = withRoute(async (req, { params }) => {
  await enforceRateLimit(req, "global", "public");
  const { type } = parseParams(await params, ParamsSchema);
  const policy = await publicPolicy(type);
  if (!policy) throw Errors.notFound("This policy has not been published yet");
  return json(policy, req);
});
