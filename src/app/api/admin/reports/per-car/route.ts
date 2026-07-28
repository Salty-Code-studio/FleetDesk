import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseParams } from "@/lib/http/validate";
import { read } from "@/lib/admin/guard";
import { perCarRevenue } from "@/lib/admin/reports";
import { arubaToday } from "@/lib/booking/public";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});

/** GET /api/admin/reports/per-car?year=YYYY — per-car monthly revenue matrix
 *  plus the borg (security deposit) summary. Read-only, owner-only. */
export const GET = withRoute(async (req) => {
  const url = new URL(req.url);
  const q = parseParams(Object.fromEntries(url.searchParams), QuerySchema);
  const year = q.year ?? Number(arubaToday().slice(0, 4));
  return json(await read(req, () => perCarRevenue(year)), req);
});
