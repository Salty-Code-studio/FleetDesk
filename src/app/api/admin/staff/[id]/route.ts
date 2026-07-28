import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseJsonBody, parseParams } from "@/lib/http/validate";
import { mutate } from "@/lib/admin/guard";
import { setStaffActive } from "@/lib/admin/staff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string().uuid() });
const BodySchema = z.object({ active: z.boolean() }).strict();

/** PATCH /api/admin/staff/[id] — activate / deactivate (owner-only). Deactivation
 *  destroys the person's sessions inside setStaffActive: instant revocation. */
export const PATCH = withRoute(async (req, { params }) => {
  const { id } = parseParams(await params, ParamsSchema);
  const body = await parseJsonBody(req, BodySchema);
  const result = await mutate(req, "admin.staff_updated", async () => {
    const r = await setStaffActive(id, body.active);
    return { result: r, entity: "admin_user", entityId: id, after: { active: r.active } };
  });
  return json(result, req);
});
