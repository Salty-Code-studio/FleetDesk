/**
 * After a decision, rewrite every delivered Telegram ping in place: summary
 * text plus "Confirmed/Declined by X", inline keyboard removed, so every
 * manager's copy shows the outcome and late taps have no buttons. Best-effort:
 * a failed edit is logged and skipped (the back office is already correct).
 */
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { approvalRequests } from "@/lib/db/schema";
import { buildApprovalMessage } from "@/lib/approval/message";
import { editMessage, telegramConfigured } from "@/lib/approval/telegram";
import { logger } from "@/lib/logger";

export async function broadcastDecision(requestId: string): Promise<void> {
  try {
    if (!telegramConfigured()) return;
    const db = await getDb();
    const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, requestId));
    if (!row || (row.status !== "confirmed" && row.status !== "declined")) return;
    const verb = row.status === "confirmed" ? "Confirmed" : "Declined";
    const by = row.decidedBy ?? "the team";
    const msg = await buildApprovalMessage(row.bookingId);
    const base = msg?.text ?? "Booking update";
    for (const d of row.sentTo) {
      if (d.channel !== "telegram" || typeof d.messageId !== "number") continue;
      try {
        await editMessage(d.to, d.messageId, `${base}\n\n${verb} by ${by}`);
      } catch (e) {
        logger.error("approval_broadcast_edit_failed", { requestId, chatId: d.to, error: (e as Error).message });
      }
    }
  } catch (e) {
    logger.error("approval_broadcast_failed", { requestId, error: (e as Error).message });
  }
}
