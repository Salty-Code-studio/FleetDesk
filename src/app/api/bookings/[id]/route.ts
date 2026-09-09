import { z } from "zod";
import { eq } from "drizzle-orm";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseParams } from "@/lib/http/validate";
import { Errors } from "@/lib/http/errors";
import { enforceRateLimit } from "@/lib/http/rate-limit";
import { getDb } from "@/lib/db/client";
import { bookings } from "@/lib/db/schema";
import { publicBreakdown, type OverridableBreakdown } from "@/lib/booking/price-override";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string().uuid() });

/** GET /api/bookings/[id] — public booking status. NO authentication: anyone
 *  holding the booking UUID can read this (rate-limited only). Licence/customer
 *  data is never selected here, and priceBreakdown is stripped of desk-internal
 *  keys (priceOverride's reason/admin id, adjustmentCents) via publicBreakdown
 *  before it leaves the server — those are audit-trail material, not the
 *  customer's business. */
export const GET = withRoute(async (req, { params }) => {
  await enforceRateLimit(req, "global", "public");
  const { id } = parseParams(await params, ParamsSchema);
  const db = await getDb();
  const [booking] = await db.select({
    id: bookings.id, status: bookings.status, startAt: bookings.startAt,
    endAt: bookings.endAt, paymentOption: bookings.paymentOption, priceBreakdown: bookings.priceBreakdown,
    // Additive (Task 12): lets the confirmation page show "Payment received: $X"
    // without a second round trip. Still no PII.
    amountPaidCents: bookings.amountPaidCents,
  }).from(bookings).where(eq(bookings.id, id));
  if (!booking) throw Errors.notFound("Booking not found");
  return json({
    ...booking,
    priceBreakdown: booking.priceBreakdown
      ? publicBreakdown(booking.priceBreakdown as OverridableBreakdown)
      : booking.priceBreakdown,
  }, req);
});
