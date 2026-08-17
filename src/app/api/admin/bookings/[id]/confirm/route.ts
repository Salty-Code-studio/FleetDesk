import { z } from "zod";
import { isDeskMode } from "@/env";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { Errors } from "@/lib/http/errors";
import { parseParams } from "@/lib/http/validate";
import { mutate } from "@/lib/admin/guard";
import { confirmBookingAdmin } from "@/lib/admin/confirm-booking";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string().uuid() });

export const POST = withRoute(async (req, { params }) => {
  // Desk deployments only. In online mode a pending booking means "payment
  // not received yet" and ONLY the Stripe webhook may flip it, so an admin
  // confirm here would confirm an UNPAID booking. Answer 404 before params
  // and before auth, mirroring the Stripe webhook's own desk-mode gate.
  if (!isDeskMode) throw Errors.notFound("Not found");
  const { id } = parseParams(await params, ParamsSchema);
  const result = await mutate(req, "admin.booking_confirmed", async (ctx) => {
    // Staff rows carry a real `name` but a synthesized placeholder email
    // (src/lib/admin/staff.ts); owner rows are the opposite (real email, no
    // `name`). Prefer whichever field actually identifies the person so
    // "Confirmed by X" in the Telegram broadcast and decidedBy in the audit
    // trail read like a real name, not a placeholder staff.local address.
    const adminName = ctx.admin.name ?? ctx.admin.email;
    const row = await confirmBookingAdmin(id, adminName);
    return { result: row, entity: "booking", entityId: id, after: { status: row.status } };
  }, { roles: ["owner", "staff"] });
  return json(result, req);
});
