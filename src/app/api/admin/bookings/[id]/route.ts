import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseParams } from "@/lib/http/validate";
import { Errors } from "@/lib/http/errors";
import { read } from "@/lib/admin/guard";
import { getBookingDetail } from "@/lib/admin/booking-detail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string().uuid() });

/** GET one booking's full detail for the admin BookingDrawer: booking, customer,
 *  vehicle, every payment row, and the computed balance/policy the drawer needs. */
export const GET = withRoute(async (req, { params }) => {
  const { id } = parseParams(await params, ParamsSchema);
  const detail = await read(req, () => getBookingDetail(id));
  if (!detail) throw Errors.notFound("Booking not found");
  return json(detail, req);
});
