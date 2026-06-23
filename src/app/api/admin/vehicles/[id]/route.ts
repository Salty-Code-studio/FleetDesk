import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseJsonBody, parseParams } from "@/lib/http/validate";
import { Errors } from "@/lib/http/errors";
import { read, mutate } from "@/lib/admin/guard";
import { getVehicle, updateVehicle, retireVehicle, VehiclePatchSchema } from "@/lib/admin/vehicles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string().uuid() });

export const GET = withRoute(async (req, { params }) => {
  const { id } = parseParams(await params, ParamsSchema);
  const vehicle = await read(req, () => getVehicle(id));
  if (!vehicle) throw Errors.notFound("Vehicle not found");
  return json(vehicle, req);
});

export const PATCH = withRoute(async (req, { params }) => {
  const { id } = parseParams(await params, ParamsSchema);
  const patch = await parseJsonBody(req, VehiclePatchSchema);
  const updated = await mutate(req, "admin.vehicle_updated", async () => {
    const before = await getVehicle(id);
    const after = await updateVehicle(id, patch);
    return { result: after, entity: "vehicle", entityId: id, before, after };
  });
  return json(updated, req);
});

/** Retire (soft) — preserves booking history. See retireVehicle. */
export const DELETE = withRoute(async (req, { params }) => {
  const { id } = parseParams(await params, ParamsSchema);
  const retired = await mutate(req, "admin.vehicle_retired", async () => {
    const before = await getVehicle(id);
    const after = await retireVehicle(id);
    return { result: after, entity: "vehicle", entityId: id, before, after };
  });
  return json(retired, req);
});
