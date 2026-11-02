import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseJsonBody, parseParams } from "@/lib/http/validate";
import { mutate, read } from "@/lib/admin/guard";
import { Errors } from "@/lib/http/errors";
import { swapOptions, swapVehicle, SwapSchema } from "@/lib/admin/swap-vehicle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string().uuid() });

/** GET the cars this booking can be swapped to: free for its exact dates. */
export const GET = withRoute(async (req, { params }) => {
  const { id } = parseParams(await params, ParamsSchema);
  const options = await read(req, () => swapOptions(id));
  if (!options) throw Errors.notFound("Booking not found");
  return json(options, req);
});

export const POST = withRoute(async (req, { params }) => {
  const { id } = parseParams(await params, ParamsSchema);
  const input = await parseJsonBody(req, SwapSchema);
  const updated = await mutate(req, "admin.booking_vehicle_swapped", async () => {
    const row = await swapVehicle(id, input);
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
