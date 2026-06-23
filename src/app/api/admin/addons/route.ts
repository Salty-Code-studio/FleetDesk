import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseJsonBody } from "@/lib/http/validate";
import { read, mutate } from "@/lib/admin/guard";
import { listAddOns, createAddOn, AddOnCreateSchema } from "@/lib/admin/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withRoute(async (req) => json(await read(req, listAddOns), req));

export const POST = withRoute(async (req) => {
  const input = await parseJsonBody(req, AddOnCreateSchema);
  const created = await mutate(req, "admin.addon_created", async () => {
    const row = await createAddOn(input);
    return { result: row, entity: "add_on", entityId: row.id, after: row };
  });
  return json(created, req, { status: 201 });
});
