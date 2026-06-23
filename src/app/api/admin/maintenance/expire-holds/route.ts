import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseJsonBody } from "@/lib/http/validate";
import { mutate } from "@/lib/admin/guard";
import { expireStaleHolds } from "@/lib/payments/holds";

export const runtime = "nodejs";

const BodySchema = z.object({ ttlMinutes: z.number().int().min(5).max(10_080).default(30) }).strict();

/** POST /api/admin/maintenance/expire-holds — cancel stale unpaid pending holds.
 *  Admin-triggered now; a scheduled cron lands in Plan 07. */
export const POST = withRoute(async (req) => {
  const { ttlMinutes } = await parseJsonBody(req, BodySchema);
  const count = await mutate(req, "admin.holds_expired", async () => {
    const n = await expireStaleHolds(ttlMinutes);
    return { result: n, entity: "booking", after: { cancelled: n, ttlMinutes } };
  });
  return json({ cancelled: count }, req);
});
