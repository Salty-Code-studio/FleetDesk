import { cookies } from "next/headers";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { requireAdmin } from "@/lib/auth/admin-auth";
import { destroySession } from "@/lib/auth/sessions";
import { SESSION_COOKIE } from "@/lib/auth/cookies";
import { clearSessionCookies } from "@/lib/auth/session-cookies";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

/** POST /api/admin/auth/logout — server-side revocation + cookie clear. */
export const POST = withRoute(async (req) => {
  const { admin } = await requireAdmin(req, { allowMfaPending: true, roles: ["owner", "staff"] });
  const cookieStore = await cookies();
  await destroySession(cookieStore.get(SESSION_COOKIE)?.value);
  await audit({ actor: admin.id, action: "admin.logout", entity: "admin_user", entityId: admin.id, req });
  return clearSessionCookies(json({ ok: true }, req));
});
