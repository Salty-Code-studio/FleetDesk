import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { read } from "@/lib/admin/guard";
import { getReports } from "@/lib/admin/reports";
import { arubaToday } from "@/lib/booking/public";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/reports — owner KPIs + revenue charts (read-only). */
export const GET = withRoute(async (req) => {
  return json(await read(req, () => getReports(arubaToday())), req);
});
