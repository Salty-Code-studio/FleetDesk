import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseJsonBody, parseParams } from "@/lib/http/validate";
import { mutate } from "@/lib/admin/guard";
import { moveBooking, MoveSchema } from "@/lib/admin/move-booking";
import { mapLegacyDateKeys } from "@/lib/booking/public";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string().uuid() });
// Legacy-key compat: the board UI still sends startDate/endDate until Task 5.
const BodySchema = z.preprocess(mapLegacyDateKeys, MoveSchema);

export const PATCH = withRoute(async (req, { params }) => {
  const { id } = parseParams(await params, ParamsSchema);
  const input = await parseJsonBody(req, BodySchema);
  const updated = await mutate(req, "admin.booking_moved", async () => {
    const row = await moveBooking(id, input);
    return {
      result: row, entity: "booking", entityId: id,
      after: { vehicleId: row.vehicleId, startAt: row.startAt, endAt: row.endAt },
    };
  }, { roles: ["owner", "staff"] });
  return json(
    { id: updated.id, vehicleId: updated.vehicleId, startAt: updated.startAt, endAt: updated.endAt },
    req,
  );
});
