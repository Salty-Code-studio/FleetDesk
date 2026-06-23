import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseJsonBody, parseParams } from "@/lib/http/validate";
import { Errors } from "@/lib/http/errors";
import { mutate } from "@/lib/admin/guard";
import { updateInsurance, deleteInsurance, InsurancePatchSchema } from "@/lib/admin/catalog";

export const runtime = "nodejs";

const ParamsSchema = z.object({ id: z.string().uuid() });

export const PATCH = withRoute(async (req, { params }) => {
  const { id } = parseParams(await params, ParamsSchema);
  const patch = await parseJsonBody(req, InsurancePatchSchema);
  const updated = await mutate(req, "admin.insurance_updated", async () => {
    const row = await updateInsurance(id, patch);
    return { result: row, entity: "insurance_tier", entityId: id, after: row };
  });
  return json(updated, req);
});

export const DELETE = withRoute(async (req, { params }) => {
  const { id } = parseParams(await params, ParamsSchema);
  await mutate(req, "admin.insurance_deleted", async () => {
    const ok = await deleteInsurance(id);
    if (!ok) throw Errors.notFound("Insurance tier not found");
    return { result: true, entity: "insurance_tier", entityId: id };
  });
  return json({ ok: true }, req);
});
