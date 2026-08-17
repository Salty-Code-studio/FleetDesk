/**
 * Admin-side confirm for pending bookings. Online mode never needed this (the
 * Stripe webhook confirmed), desk mode does. When an open approval request
 * exists we route through the SAME decision funnel as a chat tap, so the
 * request closes, the audit trail records the admin, and every Telegram ping
 * updates to "Confirmed by X". Without a request it is a plain guarded flip.
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { approvalRequests, bookings } from "@/lib/db/schema";
import { applyDecision } from "@/lib/approval/core";
import { broadcastDecision } from "@/lib/approval/broadcast";
import { notifyBookingConfirmed } from "@/lib/email/notifications";
import { Errors } from "@/lib/http/errors";

export async function confirmBookingAdmin(id: string, adminName: string): Promise<{ id: string; status: string }> {
  const db = await getDb();
  const [open] = await db.select().from(approvalRequests)
    .where(and(eq(approvalRequests.bookingId, id), eq(approvalRequests.status, "open")));

  if (open) {
    const result = await applyDecision(open.id, "confirm", { name: adminName, channel: "admin" });
    if (result.outcome === "confirmed") {
      await broadcastDecision(open.id);
      return { id, status: "confirmed" };
    }
    if (result.outcome === "already_handled") throw Errors.conflict("This booking was already handled");
    throw Errors.conflict("This booking can no longer be confirmed");
  }

  const flipped = await db.update(bookings)
    .set({ status: "confirmed", updatedAt: new Date() })
    .where(and(eq(bookings.id, id), eq(bookings.status, "pending")))
    .returning({ id: bookings.id });
  if (flipped.length === 0) throw Errors.conflict("Only a pending booking can be confirmed");
  await notifyBookingConfirmed(id).catch(() => undefined);
  return { id, status: "confirmed" };
}
