import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseParams, parseJsonBody } from "@/lib/http/validate";
import { mutate } from "@/lib/admin/guard";
import { cancelBookingAdmin } from "@/lib/admin/move-booking";
import { notifyBookingCancelled } from "@/lib/email/notifications";
import { arubaNowIso } from "@/lib/time/format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string().uuid() });
// The UI always states the choice explicitly (no silent default): required.
const BodySchema = z.object({ refund: z.boolean() });

export const POST = withRoute(async (req, { params }) => {
  const { id } = parseParams(await params, ParamsSchema);
  const { refund } = await parseJsonBody(req, BodySchema);

  const cancelled = await mutate(req, "admin.booking_cancelled", async () => {
    const row = await cancelBookingAdmin(id, refund, arubaNowIso());
    return { result: row, entity: "booking", entityId: id, after: { status: row.status, refund } };
  });

  // Best-effort notice (never blocks the cancellation).
  await notifyBookingCancelled(cancelled.id, {
    refunded: cancelled.refunded, refundCents: cancelled.refundCents, refundError: cancelled.refundError,
  });

  return json({
    id: cancelled.id, status: cancelled.status,
    refunded: cancelled.refunded, refundCents: cancelled.refundCents, policySaysFree: cancelled.policySaysFree,
  }, req);
});
