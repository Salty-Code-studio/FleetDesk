import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { requireCustomer } from "@/lib/auth/customer-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/me — the signed-in customer (for the account shell router). */
export const GET = withRoute(async (req) => {
  const { customer } = await requireCustomer(req);
  return json({ email: customer.email, name: customer.name }, req);
});
