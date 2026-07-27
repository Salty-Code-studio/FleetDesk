import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseJsonBody, parseParams } from "@/lib/http/validate";
import { mutate } from "@/lib/admin/guard";
import { refundPayment } from "@/lib/payments/refunds";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string().uuid() });
const BodySchema = z.object({ amountCents: z.number().int().positive().optional() });

export const POST = withRoute(async (req, { params }) => {
  const { id } = parseParams(await params, ParamsSchema);
  const input = await parseJsonBody(req, BodySchema);
  const updated = await mutate(req, "admin.payment_refunded", async () => {
    const result = await refundPayment(id, { amountCents: input.amountCents });
    return { result, entity: "payment", entityId: id, after: result };
  });
  return json(updated, req);
});
