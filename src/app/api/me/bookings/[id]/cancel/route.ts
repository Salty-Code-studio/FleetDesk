import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseParams } from "@/lib/http/validate";
import { requireCustomer } from "@/lib/auth/customer-auth";
import { cancelOwnBooking } from "@/lib/booking/customer-bookings";
import { getSettings } from "@/lib/admin/settings";
import { sendAndLog, sendToMany } from "@/lib/email/send";
import { bookingCancelledEmail } from "@/lib/email/templates";

export const runtime = "nodejs";

const ParamsSchema = z.object({ id: z.string().uuid() });

/** POST /api/me/bookings/[id]/cancel — cancel your own booking. */
export const POST = withRoute(async (req, { params }) => {
  const { customer } = await requireCustomer(req);
  const { id } = parseParams(await params, ParamsSchema);

  const cancelled = await cancelOwnBooking(customer.id, id);

  // Best-effort notices (never block the cancellation).
  const settings = await getSettings();
  await sendAndLog({ to: customer.email, type: "booking_cancelled", ...bookingCancelledEmail(cancelled) });
  await sendToMany(settings.adminAlertRecipients, (to) => ({
    to, type: "admin_booking_cancelled", ...bookingCancelledEmail(cancelled),
  }));

  return json({ ok: true, status: "cancelled" }, req);
});
