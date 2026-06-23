import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseParams } from "@/lib/http/validate";
import { Errors } from "@/lib/http/errors";
import { mutate } from "@/lib/admin/guard";
import { deleteBlock } from "@/lib/admin/vehicles";

export const runtime = "nodejs";

const ParamsSchema = z.object({ id: z.string().uuid() });

export const DELETE = withRoute(async (req, { params }) => {
  const { id } = parseParams(await params, ParamsSchema);
  await mutate(req, "admin.availability_block_deleted", async () => {
    const ok = await deleteBlock(id);
    if (!ok) throw Errors.notFound("Block not found");
    return { result: true, entity: "availability_block", entityId: id };
  });
  return json({ ok: true }, req);
});
