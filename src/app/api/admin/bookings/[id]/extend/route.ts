import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseJsonBody, parseParams } from "@/lib/http/validate";
import { mutate, read } from "@/lib/admin/guard";
import { extendBooking } from "@/lib/admin/extend-booking";
import { notifyBookingExtended } from "@/lib/email/notifications";
import { isoDateTime } from "@/lib/validation/iso-date";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string().uuid() });
const BodySchema = z.object({ endAt: isoDateTime, payment: z.enum(["link", "desk"]), dryRun: z.boolean().optional() }).strict();

export const POST = withRoute(async (req, { params }) => {
  const { id } = parseParams(await params, ParamsSchema);
  const body = await parseJsonBody(req, BodySchema);

  // Live delta preview: no write, no audit entry, so this goes through read()
  // rather than mutate() even though the HTTP verb is POST.
  if (body.dryRun) {
    const r = await read(req, () => extendBooking(id, body));
    return json({ deltaCents: r.deltaCents }, req);
  }

  const result = await mutate(req, "admin.booking_extended", async () => {
    const r = await extendBooking(id, body);
    return {
      result: r, entity: "booking", entityId: id,
      before: { endAt: r.previousEndAt },
      after: { endAt: r.booking.endAt, deltaCents: r.deltaCents },
    };
  });

  // Best-effort customer email + bell (never blocks the extension), carrying the
  // pay-by-link url when the desk chose "link" so the customer can settle the delta.
  await notifyBookingExtended(id, {
    deltaCents: result.deltaCents, newEndAt: result.booking.endAt, checkoutUrl: result.checkoutUrl,
  });

  return json(
    { id: result.booking.id, endAt: result.booking.endAt, deltaCents: result.deltaCents, checkoutUrl: result.checkoutUrl },
    req,
  );
});
