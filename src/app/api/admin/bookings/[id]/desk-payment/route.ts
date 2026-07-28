import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseParams, parseJsonBody } from "@/lib/http/validate";
import { mutate } from "@/lib/admin/guard";
import { recordDeskBalancePayment } from "@/lib/admin/inspections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string().uuid() });
const BodySchema = z.object({ amountCents: z.number().int().min(1).max(5_000_000) }).strict();

export const POST = withRoute(async (req, { params }) => {
  const { id } = parseParams(await params, ParamsSchema);
  const { amountCents } = await parseJsonBody(req, BodySchema);
  const updated = await mutate(req, "admin.desk_payment_recorded", async (ctx) => {
    const row = await recordDeskBalancePayment(id, amountCents, ctx.admin.id);
    return { result: row, entity: "booking", entityId: id, after: { amountCents, amountPaidCents: row.amountPaidCents } };
  });
  return json({ id: updated.id, amountPaidCents: updated.amountPaidCents }, req);
});
