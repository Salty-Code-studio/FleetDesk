import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseJsonBody, parseParams } from "@/lib/http/validate";
import { mutate } from "@/lib/admin/guard";
import { swapVehicle, SwapSchema } from "@/lib/admin/swap-vehicle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string().uuid() });

export const POST = withRoute(async (req, { params }) => {
  const { id } = parseParams(await params, ParamsSchema);
  const input = await parseJsonBody(req, SwapSchema);
  const updated = await mutate(req, "admin.booking_vehicle_swapped", async () => {
    const row = await swapVehicle(id, input);
    return {
      result: row, entity: "booking", entityId: id,
      after: {
        vehicleId: row.vehicleId, startAt: row.startAt, endAt: row.endAt,
        reason: input.reason ?? null,
        // Rentals the auto-sort re-homed to make room, for the audit trail.
        moved: row.moved.map((m) => ({ id: m.id, from: m.fromPlate, to: m.toPlate })),
      },
    };
  }, { roles: ["owner", "staff"] });
  return json(
    { id: updated.id, vehicleId: updated.vehicleId, startAt: updated.startAt, endAt: updated.endAt, moved: updated.moved },
    req,
  );
});
