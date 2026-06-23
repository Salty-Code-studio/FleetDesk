import { z } from "zod";
import { eq } from "drizzle-orm";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseParams } from "@/lib/http/validate";
import { Errors } from "@/lib/http/errors";
import { enforceRateLimit } from "@/lib/http/rate-limit";
import { getDb } from "@/lib/db/client";
import { bookings } from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string().uuid() });

/** GET /api/bookings/[id] — public booking status (no PII). Powers the
 *  confirmation page polling. Licence/customer data is never exposed here. */
export const GET = withRoute(async (req, { params }) => {
  await enforceRateLimit(req, "global", "public");
  const { id } = parseParams(await params, ParamsSchema);
  const db = await getDb();
  const [booking] = await db.select({
    id: bookings.id, status: bookings.status, startDate: bookings.startDate,
    endDate: bookings.endDate, paymentOption: bookings.paymentOption, priceBreakdown: bookings.priceBreakdown,
  }).from(bookings).where(eq(bookings.id, id));
  if (!booking) throw Errors.notFound("Booking not found");
  return json(booking, req);
});
