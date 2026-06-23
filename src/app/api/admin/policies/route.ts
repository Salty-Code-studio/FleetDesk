import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseJsonBody } from "@/lib/http/validate";
import { read, mutate } from "@/lib/admin/guard";
import { policyOverview, publishPolicy, PolicyPublishSchema } from "@/lib/admin/policies";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withRoute(async (req) => json(await read(req, policyOverview), req));

export const POST = withRoute(async (req) => {
  const input = await parseJsonBody(req, PolicyPublishSchema);
  const published = await mutate(req, "admin.policy_published", async () => {
    const row = await publishPolicy(input);
    return { result: row, entity: "policy", entityId: `${row.type}:v${row.version}`, after: { type: row.type, version: row.version } };
  });
  return json(published, req, { status: 201 });
});
