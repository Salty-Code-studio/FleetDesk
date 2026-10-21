import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { read } from "@/lib/admin/guard";
import { getSetupProgress } from "@/lib/admin/setup-progress-loader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/setup-progress — owner setup checklist (read-only). */
export const GET = withRoute(async (req) => {
  return json(await read(req, () => getSetupProgress()), req);
});
