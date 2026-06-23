import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseJsonBody } from "@/lib/http/validate";
import { read, mutate } from "@/lib/admin/guard";
import { listInsurance, createInsurance, InsuranceCreateSchema } from "@/lib/admin/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withRoute(async (req) => json(await read(req, listInsurance), req));

export const POST = withRoute(async (req) => {
  const input = await parseJsonBody(req, InsuranceCreateSchema);
  const created = await mutate(req, "admin.insurance_created", async () => {
    const row = await createInsurance(input);
    return { result: row, entity: "insurance_tier", entityId: row.id, after: row };
  });
  return json(created, req, { status: 201 });
});
