import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { requireAdmin } from "@/lib/auth/admin-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/auth/me — session state for the admin shell router. */
export const GET = withRoute(async (req) => {
  const { admin, session } = await requireAdmin(req, {
    allowMfaPending: true,
    roles: ["owner", "staff"],
  });
  return json({
    email: admin.email,
    name: admin.name,
    role: admin.role,
    mfaEnabled: admin.mfaEnabled,
    mfaPending: session.mfaPending,
  }, req);
});
