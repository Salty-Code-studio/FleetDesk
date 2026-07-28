import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { read } from "@/lib/admin/guard";
import { complianceOverview } from "@/lib/admin/compliance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withRoute(async (req) => json(await read(req, () => complianceOverview(), { roles: ["owner", "staff"] }), req));
