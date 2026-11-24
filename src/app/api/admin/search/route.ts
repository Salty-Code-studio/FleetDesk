import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseParams } from "@/lib/http/validate";
import { read } from "@/lib/admin/guard";
import { searchDesk, SearchQuerySchema } from "@/lib/admin/search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/search?q= — customers and their rentals, grouped. Read-only, any desk role. */
export const GET = withRoute(async (req) => {
  const url = new URL(req.url);
  const { q } = parseParams(Object.fromEntries(url.searchParams), SearchQuerySchema);
  return json(await read(req, () => searchDesk(q)), req);
});
