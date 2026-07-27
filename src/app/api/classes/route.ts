import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { enforceRateLimit } from "@/lib/http/rate-limit";
import { parseParams } from "@/lib/http/validate";
import { getClasses } from "@/lib/booking/classes";
import { normalizeTs } from "@/lib/booking/public";
import { getSettings } from "@/lib/admin/settings";
import { isoDateTime } from "@/lib/validation/iso-date";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QuerySchema = (openingTime: string) => z.object({
  pickup: z.string().transform((v) => normalizeTs(v, openingTime)).pipe(isoDateTime).optional(),
  return: z.string().transform((v) => normalizeTs(v, openingTime)).pipe(isoDateTime).optional(),
});

/** GET /api/classes?pickup&return — public. The bookable car TYPES with their
 *  per-class day rate, and (when dates are given) an available car to hold. */
export const GET = withRoute(async (req) => {
  await enforceRateLimit(req, "global", "public");
  const settings = await getSettings();
  const url = new URL(req.url);
  const q = parseParams(Object.fromEntries(url.searchParams), QuerySchema(settings.openingTime));
  return json(await getClasses(q.pickup, q.return), req);
});
