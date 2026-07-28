import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { enforceRateLimit } from "@/lib/http/rate-limit";
import { publicBookingConfig } from "@/lib/booking/public";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/booking-config — public, non-sensitive settings the booking wizard
 *  needs before it can quote (driver age bands and the young-driver fee). */
export const GET = withRoute(async (req) => {
  await enforceRateLimit(req, "global", "public");
  return json(await publicBookingConfig(), req);
});
