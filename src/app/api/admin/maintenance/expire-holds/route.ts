import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseJsonBody } from "@/lib/http/validate";
import { mutate } from "@/lib/admin/guard";
import { expireStaleHolds } from "@/lib/payments/holds";
import { Errors } from "@/lib/http/errors";
import { isDeskMode } from "@/env";

export const runtime = "nodejs";

const BodySchema = z.object({ ttlMinutes: z.number().int().min(5).max(10_080).default(30) }).strict();

/** POST /api/admin/maintenance/expire-holds — cancel stale unpaid pending holds.
 *  Admin-triggered now; a scheduled cron lands in Plan 07. Desk-mode
 *  deployments never have an online payment to abandon: every pending
 *  booking there is a real desk hold awaiting a manager's confirm/decline, so
 *  this must never expire anything (same reasoning as the cron twin at
 *  /api/cron/expire-holds). Gate FIRST, before body parsing or auth, so it
 *  cannot be reached by any authenticated caller in desk mode. */
export const POST = withRoute(async (req) => {
  if (isDeskMode) {
    throw Errors.conflict("Hold expiry is not available in desk mode: bookings have no online payment to abandon");
  }
  const { ttlMinutes } = await parseJsonBody(req, BodySchema);
  const count = await mutate(req, "admin.holds_expired", async () => {
    const n = await expireStaleHolds(ttlMinutes);
    return { result: n, entity: "booking", after: { cancelled: n, ttlMinutes } };
  });
  return json({ cancelled: count }, req);
});
