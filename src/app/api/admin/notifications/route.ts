import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { read } from "@/lib/admin/guard";
import { listNotifications } from "@/lib/admin/notifications-feed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/notifications — recent in-app notifications + unread count. */
export const GET = withRoute((req) => read(req, async () => json(await listNotifications(), req)));
