import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseJsonBody, parseParams } from "@/lib/http/validate";
import { mutate } from "@/lib/admin/guard";
import { getNote, setNoteResolved, NotePatchSchema } from "@/lib/admin/vehicle-notes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string().uuid() });

export const PATCH = withRoute(async (req, { params }) => {
  const { id } = parseParams(await params, ParamsSchema);
  const { resolved } = await parseJsonBody(req, NotePatchSchema);
  const action = resolved ? "admin.vehicle_note_resolved" : "admin.vehicle_note_reopened";
  const updated = await mutate(req, action, async () => {
    const before = await getNote(id);
    const after = await setNoteResolved(id, resolved);
    return { result: after, entity: "vehicle_note", entityId: id, before, after };
  }, { roles: ["owner", "staff"] });
  return json(updated, req);
});
