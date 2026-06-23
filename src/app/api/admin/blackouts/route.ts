import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseJsonBody } from "@/lib/http/validate";
import { read, mutate } from "@/lib/admin/guard";
import { listBlackouts, createBlackout, BlackoutSchema } from "@/lib/admin/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withRoute(async (req) => json(await read(req, listBlackouts), req));

export const POST = withRoute(async (req) => {
  const input = await parseJsonBody(req, BlackoutSchema);
  const created = await mutate(req, "admin.blackout_created", async () => {
    const row = await createBlackout(input);
    return { result: row, entity: "blackout_date", entityId: row.id, after: row };
  });
  return json(created, req, { status: 201 });
});
