import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseParams } from "@/lib/http/validate";
import { Errors } from "@/lib/http/errors";
import { mutate } from "@/lib/admin/guard";
import { deleteBlackout } from "@/lib/admin/settings";

export const runtime = "nodejs";

const ParamsSchema = z.object({ id: z.string().uuid() });

export const DELETE = withRoute(async (req, { params }) => {
  const { id } = parseParams(await params, ParamsSchema);
  await mutate(req, "admin.blackout_deleted", async () => {
    const ok = await deleteBlackout(id);
    if (!ok) throw Errors.notFound("Blackout not found");
    return { result: true, entity: "blackout_date", entityId: id };
  });
  return json({ ok: true }, req);
});
