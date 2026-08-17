/**
 * Cron chores for the approval loop. Janitor first: any OPEN request whose
 * booking is no longer pending is closed (decided in the admin, cancelled,
 * or picked up). Then reminders: re-ping Telegram for open requests still
 * pending, unexpired, under the reminder cap, and quiet for at least
 * approvalReminderHours. Never customer-facing; an unanswered booking just
 * stays pending in the admin.
 */
import { and, eq, inArray, ne } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { approvalRequests, bookings, type ApprovalDelivery } from "@/lib/db/schema";
import { getSettings } from "@/lib/admin/settings";
import { buildApprovalMessage } from "@/lib/approval/message";
import { telegramConfigured, sendApprovalMessage } from "@/lib/approval/telegram";
import { notifyAdmin } from "@/lib/notify";
import { logger } from "@/lib/logger";

export async function runApprovalReminders(now = new Date()): Promise<{ reminded: number; closed: number }> {
  const db = await getDb();
  const settings = await getSettings();

  // Janitor: open requests whose booking left "pending".
  const stale = await db.select({ id: approvalRequests.id, bookingId: approvalRequests.bookingId })
    .from(approvalRequests)
    .innerJoin(bookings, eq(approvalRequests.bookingId, bookings.id))
    .where(and(eq(approvalRequests.status, "open"), ne(bookings.status, "pending")));
  if (stale.length) {
    await db.update(approvalRequests)
      .set({ status: "closed", updatedAt: now })
      .where(inArray(approvalRequests.id, stale.map((s) => s.id)));
  }

  // Reminders.
  const open = await db.select({ request: approvalRequests })
    .from(approvalRequests)
    .innerJoin(bookings, eq(approvalRequests.bookingId, bookings.id))
    .where(and(eq(approvalRequests.status, "open"), eq(bookings.status, "pending")));

  const threshold = settings.approvalReminderHours * 3600_000;
  let reminded = 0;
  for (const { request } of open) {
    if (request.reminderCount >= settings.approvalMaxReminders) continue;
    if (request.expiresAt.getTime() < now.getTime()) continue;
    const last = request.remindedAt ?? request.createdAt;
    if (now.getTime() - last.getTime() < threshold) continue;

    const msg = await buildApprovalMessage(request.bookingId);
    if (!msg) continue;
    const deliveries: ApprovalDelivery[] = [...request.sentTo];
    if (telegramConfigured()) {
      for (const m of settings.approvalManagers.filter((m) => m.chatId)) {
        try {
          const messageId = await sendApprovalMessage(m.chatId!, `Reminder: ${msg.text}`, request.id);
          deliveries.push({ channel: "telegram", to: m.chatId!, messageId: messageId ?? undefined, sentAt: now.toISOString() });
        } catch (e) {
          logger.error("approval_reminder_send_failed", { requestId: request.id, error: (e as Error).message });
        }
      }
    }
    await db.update(approvalRequests)
      .set({ reminderCount: request.reminderCount + 1, remindedAt: now, sentTo: deliveries, updatedAt: now })
      .where(eq(approvalRequests.id, request.id));
    await notifyAdmin({
      level: "warning", type: "approval.reminder", title: "Booking still waiting for approval",
      body: msg.fleetLine, bookingId: request.bookingId,
    });
    reminded += 1;
  }
  return { reminded, closed: stale.length };
}
