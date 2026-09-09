import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseParams, parseJsonBody } from "@/lib/http/validate";
import { mutate } from "@/lib/admin/guard";
import { setBookingPrice } from "@/lib/admin/set-booking-price";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string().uuid() });
const BodySchema = z.object({
  subtotalCents: z.number().int().min(0).max(5_000_000),
  // Required on purpose: six months later the audit row is the only place that
  // remembers why a rental was $80 cheaper.
  reason: z.string().trim().min(3).max(500),
}).strict();

/** PATCH /api/admin/bookings/:id/price — owner-only price override. The
 *  original quote is preserved and the difference is recorded as a signed
 *  adjustment line, so the rental contract still itemises and still adds up. */
export const PATCH = withRoute(async (req, { params }) => {
  const { id } = parseParams(await params, ParamsSchema);
  const body = await parseJsonBody(req, BodySchema);

  const result = await mutate(req, "admin.booking_price_changed", async (ctx) => {
    const r = await setBookingPrice(id, {
      subtotalCents: body.subtotalCents,
      reason: body.reason,
      adminId: ctx.admin.id,
      role: ctx.admin.role,
    });
    return {
      result: r,
      entity: "booking",
      entityId: id,
      before: { subtotalCents: r.previousSubtotalCents },
      after: { subtotalCents: r.newSubtotalCents, reason: body.reason.trim() },
    };
  }, { roles: ["owner"] });

  const bd = result.booking.priceBreakdown as { subtotalCents?: number; adjustmentCents?: number };
  return json({ id: result.booking.id, subtotalCents: bd.subtotalCents, adjustmentCents: bd.adjustmentCents }, req);
});
