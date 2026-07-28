import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseJsonBody } from "@/lib/http/validate";
import { read, mutate } from "@/lib/admin/guard";
import { listVehicles, createVehicle, VehicleCreateSchema } from "@/lib/admin/vehicles";
import { openNoteCounts } from "@/lib/admin/vehicle-notes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Fleet READ is staff-visible (workstream 8); create/edit below stay owner-only.
export const GET = withRoute(async (req) =>
  json(await read(req, async () => {
    const [rows, counts] = await Promise.all([listVehicles(), openNoteCounts()]);
    return rows.map((v) => ({ ...v, openNotes: counts.get(v.id) ?? 0 }));
  }, { roles: ["owner", "staff"] }), req));

export const POST = withRoute(async (req) => {
  const input = await parseJsonBody(req, VehicleCreateSchema);
  const created = await mutate(req, "admin.vehicle_created", async () => {
    const row = await createVehicle(input);
    return { result: row, entity: "vehicle", entityId: row.id, after: row };
  });
  return json(created, req, { status: 201 });
});
