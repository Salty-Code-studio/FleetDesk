import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseParams } from "@/lib/http/validate";
import { mutate } from "@/lib/admin/guard";
import { escalateNoteToBlock } from "@/lib/admin/vehicle-notes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string().uuid() });

export const POST = withRoute(async (req, { params }) => {
  const { id } = parseParams(await params, ParamsSchema);
  const result = await mutate(req, "admin.vehicle_note_escalated", async () => {
    const { note, block } = await escalateNoteToBlock(id);
    return { result: { note, block }, entity: "availability_block", entityId: block.id, after: block };
  });
  return json(result, req, { status: 201 });
});
