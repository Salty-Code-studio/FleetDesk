import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseJsonBody, parseParams } from "@/lib/http/validate";
import { Errors } from "@/lib/http/errors";
import { mutate } from "@/lib/admin/guard";
import { updateAddOn, deleteAddOn, AddOnPatchSchema } from "@/lib/admin/catalog";

export const runtime = "nodejs";

const ParamsSchema = z.object({ id: z.string().uuid() });

export const PATCH = withRoute(async (req, { params }) => {
  const { id } = parseParams(await params, ParamsSchema);
  const patch = await parseJsonBody(req, AddOnPatchSchema);
  const updated = await mutate(req, "admin.addon_updated", async () => {
    const row = await updateAddOn(id, patch);
    return { result: row, entity: "add_on", entityId: id, after: row };
  });
  return json(updated, req);
});

export const DELETE = withRoute(async (req, { params }) => {
  const { id } = parseParams(await params, ParamsSchema);
  await mutate(req, "admin.addon_deleted", async () => {
    const ok = await deleteAddOn(id);
    if (!ok) throw Errors.notFound("Add-on not found");
    return { result: true, entity: "add_on", entityId: id };
  });
  return json({ ok: true }, req);
});
