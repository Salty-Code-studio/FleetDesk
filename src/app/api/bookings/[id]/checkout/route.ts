import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseParams } from "@/lib/http/validate";
import { enforceRateLimit } from "@/lib/http/rate-limit";
import { enforceOrigin } from "@/lib/auth/csrf";
import { env, isDeskMode } from "@/env";
import { Errors } from "@/lib/http/errors";
import { createBookingCheckout } from "@/lib/payments/checkout";

export const runtime = "nodejs";

const ParamsSchema = z.object({ id: z.string().uuid() });

/** POST /api/bookings/[id]/checkout — start Stripe Checkout for a pending booking. */
export const POST = withRoute(async (req, { params }) => {
  if (isDeskMode) throw Errors.conflict("Online payment is not enabled for this site");
  // CSRF: unauthenticated guest endpoint that starts a paid Stripe session, so
  // guard it with the Origin/Referer allowlist (fail-closed) to block cross-site
  // requests from churning checkout sessions for a known booking id.
  enforceOrigin(req);
  await enforceRateLimit(req, "global", "checkout");
  const { id } = parseParams(await params, ParamsSchema);
  const result = await createBookingCheckout(id, env.APP_ORIGIN);
  return json(result, req);
});
