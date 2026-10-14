import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { read } from "@/lib/admin/guard";
import { getToday } from "@/lib/admin/today-loader";
import { arubaToday, arubaNowIso } from "@/lib/booking/public";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/today: the operator's queue for the current Aruba day.
 *  Staff opt-in: Today is the staff home surface, like the board. */
export const GET = withRoute(async (req) =>
  json(await read(req, async (ctx) => ({ ...(await getToday(arubaToday(), arubaNowIso())), viewerRole: ctx.admin.role }), { roles: ["owner", "staff"] }), req),
);
