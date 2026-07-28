import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseJsonBody } from "@/lib/http/validate";
import { enforceRateLimit } from "@/lib/http/rate-limit";
import { enforceOrigin } from "@/lib/auth/csrf";
import { createBooking, BookingCreateSchema } from "@/lib/booking/create";
import { arubaNowIso, mapLegacyDateKeys } from "@/lib/booking/public";
import { notifyNewBooking } from "@/lib/email/notifications";

export const runtime = "nodejs";

// Legacy-key compat: the Phase 1 site still posts startDate/endDate.
const BodySchema = z.preprocess(mapLegacyDateKeys, BookingCreateSchema);

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
  const input = await parseJsonBody(req, BodySchema);
  const { booking, breakdown, replayed, priceAdjusted } = await createBooking(input, arubaNowIso());
  if (!replayed) await notifyNewBooking(booking.id); // best-effort admin alert
  return json({
    id: booking.id,
    status: booking.status,
    startAt: booking.startAt,
    endAt: booking.endAt,
    paymentOption: booking.paymentOption,
    breakdown,
    replayed,
    priceAdjusted,
  }, req, { status: replayed ? 200 : 201 });
});
