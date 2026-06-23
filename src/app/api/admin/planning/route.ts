import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseParams } from "@/lib/http/validate";
import { read } from "@/lib/admin/guard";
import { getPlanning } from "@/lib/admin/planning";
import { arubaToday } from "@/lib/booking/public";
import { isoDate } from "@/lib/validation/iso-date";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QuerySchema = z.object({ from: isoDate.optional(), to: isoDate.optional() });

/** GET /api/admin/planning?from&to — fleet timeline data. Defaults to a 2-week
 *  window from today when no range is given. Capped at 60 days. */
export const GET = withRoute(async (req) => {
  const url = new URL(req.url);
  const q = parseParams(Object.fromEntries(url.searchParams), QuerySchema);
  const from = q.from ?? arubaToday();
  let to = q.to ?? new Date(Date.parse(`${from}T00:00:00Z`) + 13 * 86_400_000).toISOString().slice(0, 10);
  // clamp to <= 60 days
  const maxTo = new Date(Date.parse(`${from}T00:00:00Z`) + 59 * 86_400_000).toISOString().slice(0, 10);
  if (to > maxTo) to = maxTo;
  if (to < from) to = from;
  return json(await read(req, () => getPlanning(from, to)), req);
});
