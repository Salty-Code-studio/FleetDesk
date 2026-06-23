import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { enforceRateLimit } from "@/lib/http/rate-limit";
import { parseParams } from "@/lib/http/validate";
import { getClasses } from "@/lib/booking/classes";
import { isoDate } from "@/lib/validation/iso-date";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QuerySchema = z.object({ pickup: isoDate.optional(), return: isoDate.optional() });

/** GET /api/classes?pickup&return — public. The bookable car TYPES with their
 *  per-class day rate, and (when dates are given) an available car to hold. */
export const GET = withRoute(async (req) => {
  await enforceRateLimit(req, "global", "public");
  const url = new URL(req.url);
  const q = parseParams(Object.fromEntries(url.searchParams), QuerySchema);
  return json(await getClasses(q.pickup, q.return), req);
});
