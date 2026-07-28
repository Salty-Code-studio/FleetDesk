import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseParams, parseJsonBody } from "@/lib/http/validate";
import { mutate } from "@/lib/admin/guard";
import { upsertInspection, InspectionPatchSchema } from "@/lib/admin/inspections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string().uuid(), kind: z.enum(["pickup", "return"]) });

/** Upsert draft inspection fields. One request per checklist toggle = one audit entry. */
export const PUT = withRoute(async (req, { params }) => {
  const { id, kind } = parseParams(await params, ParamsSchema);
  const patch = await parseJsonBody(req, InspectionPatchSchema);
  const updated = await mutate(req, "admin.inspection_updated", async (ctx) => {
    const { before, after } = await upsertInspection(id, kind, patch, ctx.admin.id);
    return { result: after, entity: "inspection", entityId: after.id, before, after };
  }, { roles: ["owner", "staff"] });
  return json(updated, req);
});
