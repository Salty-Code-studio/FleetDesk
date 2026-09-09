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

/** True when `s` is not just YYYY-MM-DD-shaped but a real calendar date — e.g.
 *  rejects 2027-02-30. `Date` silently rolls an out-of-range day/month into the
 *  next one (new Date("2027-02-30") becomes March 2nd), so a format-only regex
 *  lets nonsense through; round-tripping back to the same ISO date string
 *  catches that roll-over without a date library. */
function isRealCalendarDate(s: string): boolean {
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const BodySchema = z.object({
  // "Betaald t/m": how far the renter has paid on a monthly rental. null clears
  // the marker and the board falls back to the amount-based unpaid flag.
  paidUntil: z.string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
    .refine(isRealCalendarDate, "must be a real calendar date")
    .nullable(),
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
