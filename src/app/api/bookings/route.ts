import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseJsonBody } from "@/lib/http/validate";
import { enforceRateLimit } from "@/lib/http/rate-limit";
import { enforceOrigin } from "@/lib/auth/csrf";
import { createBooking, BookingCreateSchema } from "@/lib/booking/create";
import { arubaToday } from "@/lib/booking/public";
import { notifyNewBooking } from "@/lib/email/notifications";

export const runtime = "nodejs";

/**
 * POST /api/bookings — create a pending booking (public). Idempotent via the
 * idempotencyKey in the body. Payment (Stripe) is wired in Plan 05; this returns
 * the pending booking and its server-computed breakdown. Licence plaintext is
 * never echoed back.
 */
export const POST = withRoute(async (req) => {
  // CSRF: unauthenticated guest endpoint that writes a booking + licence PII, so
  // guard with the Origin/Referer allowlist (fail-closed) against cross-site posts.
  enforceOrigin(req);
  await enforceRateLimit(req, "global", "booking");
  const input = await parseJsonBody(req, BookingCreateSchema);
  const { booking, breakdown, replayed } = await createBooking(input, arubaToday());
  if (!replayed) await notifyNewBooking(booking.id); // best-effort admin alert
  return json({
    id: booking.id,
    status: booking.status,
    startDate: booking.startDate,
    endDate: booking.endDate,
    paymentOption: booking.paymentOption,
    breakdown,
    replayed,
  }, req, { status: replayed ? 200 : 201 });
});
