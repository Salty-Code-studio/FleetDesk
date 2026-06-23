import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseParams } from "@/lib/http/validate";
import { mutate } from "@/lib/admin/guard";
import { cancelBookingAdmin } from "@/lib/admin/move-booking";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string().uuid() });

export const POST = withRoute(async (req, { params }) => {
  const { id } = parseParams(await params, ParamsSchema);
  const updated = await mutate(req, "admin.booking_cancelled", async () => {
    const row = await cancelBookingAdmin(id);
    return { result: row, entity: "booking", entityId: id, after: { status: row.status } };
  });
  return json({ id: updated.id, status: updated.status }, req);
});
