import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseParams, parseJsonBody } from "@/lib/http/validate";
import { mutate } from "@/lib/admin/guard";
import { completePickup, completeReturn } from "@/lib/admin/inspections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string().uuid(), kind: z.enum(["pickup", "return"]) });
const BodySchema = z.object({ overrideNote: z.string().trim().min(3).max(500).optional() }).strict();

export const POST = withRoute(async (req, { params }) => {
  const { id, kind } = parseParams(await params, ParamsSchema);
  const body = await parseJsonBody(req, BodySchema);
  const action = kind === "pickup" ? "admin.checkin_completed" : "admin.checkout_completed";
  const updated = await mutate(req, action, async (ctx) => {
    const row = kind === "pickup"
      ? await completePickup(id, { actorId: ctx.admin.id, overrideNote: body.overrideNote })
      : await completeReturn(id, { actorId: ctx.admin.id });
    return { result: row, entity: "booking", entityId: id, after: { status: row.status } };
  }, { roles: ["owner", "staff"] });
  return json({ id: updated.id, status: updated.status }, req);
});
