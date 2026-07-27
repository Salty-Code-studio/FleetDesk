import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseJsonBody } from "@/lib/http/validate";
import { enforceRateLimit } from "@/lib/http/rate-limit";
import { publicQuote, arubaNowIso, normalizeTs, mapLegacyDateKeys } from "@/lib/booking/public";
import { isoDateTime } from "@/lib/validation/iso-date";

export const runtime = "nodejs";

const BodySchema = z.preprocess(mapLegacyDateKeys, z.object({
  vehicleSlug: z.string().trim().min(1).max(80),
  startAt: z.string().transform(normalizeTs).pipe(isoDateTime),
  endAt: z.string().transform(normalizeTs).pipe(isoDateTime),
  insuranceTierId: z.string().uuid().nullable().optional(),
  addOns: z.array(z.object({ addOnId: z.string().uuid(), qty: z.number().int().min(1).max(10) })).max(20).optional(),
}).strict());

/** POST /api/quote — server-computed price for a prospective booking. */
export const POST = withRoute(async (req) => {
  await enforceRateLimit(req, "global", "public");
  const body = await parseJsonBody(req, BodySchema);
  return json(await publicQuote(body, arubaNowIso()), req);
});
