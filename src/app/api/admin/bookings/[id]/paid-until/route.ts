import { z } from "zod";
import { eq } from "drizzle-orm";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseParams, parseJsonBody } from "@/lib/http/validate";
import { mutate } from "@/lib/admin/guard";
import { getDb } from "@/lib/db/client";
import { bookings } from "@/lib/db/schema";
import { Errors } from "@/lib/http/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string().uuid() });
const BodySchema = z.object({
  // "Betaald t/m": how far the renter has paid on a monthly rental. null clears
  // the marker and the board falls back to the amount-based unpaid flag.
  paidUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD").nullable(),
}).strict();

/** POST /api/admin/bookings/:id/paid-until — set or clear the paid-until
 *  marker on an active rental. Pure marker: the payments ledger is untouched. */
export const POST = withRoute(async (req, { params }) => {
  const { id } = parseParams(await params, ParamsSchema);
  const { paidUntil } = await parseJsonBody(req, BodySchema);
  const updated = await mutate(req, "admin.paid_until_set", async () => {
    const db = await getDb();
    const [booking] = await db.select().from(bookings).where(eq(bookings.id, id));
    if (!booking) throw Errors.notFound("Booking not found");
    if (booking.status === "cancelled") throw Errors.conflict("This booking is cancelled");
    const [row] = await db.update(bookings)
      .set({ paidUntil, updatedAt: new Date() })
      .where(eq(bookings.id, id))
      .returning();
    return { result: row!, entity: "booking", entityId: id, after: { paidUntil } };
  });
  return json({ id: updated.id, paidUntil: updated.paidUntil }, req);
});
