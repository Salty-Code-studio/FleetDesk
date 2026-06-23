import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseJsonBody, parseParams } from "@/lib/http/validate";
import { mutate } from "@/lib/admin/guard";
import { moveBooking, MoveSchema } from "@/lib/admin/move-booking";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string().uuid() });

export const PATCH = withRoute(async (req, { params }) => {
  const { id } = parseParams(await params, ParamsSchema);
  const input = await parseJsonBody(req, MoveSchema);
  const updated = await mutate(req, "admin.booking_moved", async () => {
    const row = await moveBooking(id, input);
    return {
      result: row, entity: "booking", entityId: id,
      after: { vehicleId: row.vehicleId, startDate: row.startDate, endDate: row.endDate },
    };
  });
  return json(
    { id: updated.id, vehicleId: updated.vehicleId, startDate: updated.startDate, endDate: updated.endDate },
    req,
  );
});
