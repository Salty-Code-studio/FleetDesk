import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseParams } from "@/lib/http/validate";
import { requireCustomer } from "@/lib/auth/customer-auth";
import { cancelOwnBooking } from "@/lib/booking/customer-bookings";
import { notifyBookingCancelled } from "@/lib/email/notifications";
import { arubaNowIso } from "@/lib/booking/public";

export const runtime = "nodejs";

const ParamsSchema = z.object({ id: z.string().uuid() });

/** POST /api/me/bookings/[id]/cancel — cancel your own booking. Applies the
 *  cancellation window policy (spec §16): outside the window, the paid amount
 *  auto-refunds; inside it, the deposit is not refunded. */
export const POST = withRoute(async (req, { params }) => {
  const { customer } = await requireCustomer(req);
  const { id } = parseParams(await params, ParamsSchema);

  const cancelled = await cancelOwnBooking(customer.id, id, arubaNowIso());

  // Best-effort notices (never block the cancellation).
  await notifyBookingCancelled(cancelled.id, {
    refunded: cancelled.refunded, refundCents: cancelled.refundCents, refundError: cancelled.refundError,
  });

  return json({ ok: true, status: "cancelled", refunded: cancelled.refunded, refundCents: cancelled.refundCents }, req);
});
