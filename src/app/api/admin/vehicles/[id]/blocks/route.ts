import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseJsonBody, parseParams } from "@/lib/http/validate";
import { read, mutate } from "@/lib/admin/guard";
import { listBlocks, createBlock, BlockSchema } from "@/lib/admin/vehicles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string().uuid() });

export const GET = withRoute(async (req, { params }) => {
  const { id } = parseParams(await params, ParamsSchema);
  return json(await read(req, () => listBlocks(id)), req);
});

export const POST = withRoute(async (req, { params }) => {
  const { id } = parseParams(await params, ParamsSchema);
  const input = await parseJsonBody(req, BlockSchema);
  const created = await mutate(req, "admin.availability_block_created", async () => {
    const row = await createBlock(id, input);
    return { result: row, entity: "availability_block", entityId: row.id, after: row };
  });
  return json(created, req, { status: 201 });
});
