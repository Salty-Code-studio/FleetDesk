import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseJsonBody, parseParams } from "@/lib/http/validate";
import { read, mutate } from "@/lib/admin/guard";
import { listNotes, createNote, NoteCreateSchema } from "@/lib/admin/vehicle-notes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string().uuid() });

export const GET = withRoute(async (req, { params }) => {
  const { id } = parseParams(await params, ParamsSchema);
  return json(await read(req, () => listNotes(id), { roles: ["owner", "staff"] }), req);
});

export const POST = withRoute(async (req, { params }) => {
  const { id } = parseParams(await params, ParamsSchema);
  const input = await parseJsonBody(req, NoteCreateSchema);
  const created = await mutate(req, "admin.vehicle_note_created", async (ctx) => {
    const row = await createNote(id, input, ctx.admin.id);
    return { result: row, entity: "vehicle_note", entityId: row.id, after: row };
  }, { roles: ["owner", "staff"] });
  return json(created, req, { status: 201 });
});
