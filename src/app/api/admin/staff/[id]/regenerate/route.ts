import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseParams } from "@/lib/http/validate";
import { mutate } from "@/lib/admin/guard";
import { regenerateStaffCode } from "@/lib/admin/staff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string().uuid() });

/** POST /api/admin/staff/[id]/regenerate — issue a fresh code (owner-only). The
 *  old code stops working and live sessions are revoked inside the lib. The new
 *  code appears ONCE in this response; the audit entry never contains it. */
export const POST = withRoute(async (req, { params }) => {
  const { id } = parseParams(await params, ParamsSchema);
  const result = await mutate(req, "admin.staff_code_regenerated", async () => {
    const r = await regenerateStaffCode(id);
    return { result: r, entity: "admin_user", entityId: id };
  });
  return json(result, req);
});
