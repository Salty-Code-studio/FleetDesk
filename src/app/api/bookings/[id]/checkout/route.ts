import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseParams } from "@/lib/http/validate";
import { enforceRateLimit } from "@/lib/http/rate-limit";
import { env } from "@/env";
import { createBookingCheckout } from "@/lib/payments/checkout";

export const runtime = "nodejs";

const ParamsSchema = z.object({ id: z.string().uuid() });

/** POST /api/bookings/[id]/checkout — start Stripe Checkout for a pending booking. */
export const POST = withRoute(async (req, { params }) => {
  await enforceRateLimit(req, "global", "checkout");
  const { id } = parseParams(await params, ParamsSchema);
  const result = await createBookingCheckout(id, env.APP_ORIGIN);
  return json(result, req);
});
