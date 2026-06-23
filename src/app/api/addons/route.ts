import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { enforceRateLimit } from "@/lib/http/rate-limit";
import { publicAddOns } from "@/lib/booking/public";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withRoute(async (req) => {
  await enforceRateLimit(req, "global", "public");
  return json(await publicAddOns(), req);
});
