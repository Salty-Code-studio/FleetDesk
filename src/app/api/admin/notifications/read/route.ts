import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseJsonBody } from "@/lib/http/validate";
import { requireAdmin } from "@/lib/auth/admin-auth";
import { markNotificationsRead } from "@/lib/admin/notifications-feed";

export const runtime = "nodejs";

const BodySchema = z.object({ ids: z.array(z.string().uuid()).max(200).optional() }).strict();

/** POST /api/admin/notifications/read — mark ids (or all unread) as read. */
export const POST = withRoute(async (req) => {
  await requireAdmin(req); // live admin session + CSRF on this unsafe method
  const body = await parseJsonBody(req, BodySchema);
  return json(await markNotificationsRead(body.ids), req);
});
