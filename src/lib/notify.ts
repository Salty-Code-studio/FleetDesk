/**
 * Notification dispatch. Two surfaces, both BEST-EFFORT (they never throw into a
 * booking/payment flow — a notification failure must not break a reservation):
 *   - notifyAdmin(): a durable in-app row for the ops-board bell.
 *   - alertOwner():  push to the owner's external channels — email now (Resend),
 *                    WhatsApp when the WHATSAPP_* env is configured.
 */
import { getDb } from "@/lib/db/client";
import { notifications } from "@/lib/db/schema";
import { getSettings } from "@/lib/admin/settings";
import { sendToMany } from "@/lib/email/send";
import { env } from "@/env";
import { logger } from "@/lib/logger";

export type NotificationLevel = "info" | "success" | "warning" | "critical";

export interface AdminNotification {
  level?: NotificationLevel;
  type: string;
  title: string;
  body?: string;
  bookingId?: string | null;
}

/** Record an in-app admin notification (the bell feed). Never throws. */
export async function notifyAdmin(n: AdminNotification): Promise<void> {
  try {
    const db = await getDb();
    await db.insert(notifications).values({
      level: n.level ?? "info",
      type: n.type,
      title: n.title,
      body: n.body ?? "",
      bookingId: n.bookingId ?? null,
    });
  } catch (e) {
    logger.error("notify_admin_failed", { type: n.type, error: (e as Error).message });
  }
}

/**
 * Push an alert to the OWNER's external channels. Email goes to
 * settings.adminAlertRecipients (Resend). WhatsApp is sent only when configured.
 * Never throws.
 */
export async function alertOwner(a: { type: string; subject: string; html: string; whatsappText?: string }): Promise<void> {
  try {
    const settings = await getSettings();
    if (settings.adminAlertRecipients.length) {
      await sendToMany(settings.adminAlertRecipients, (to) => ({ to, type: a.type, subject: a.subject, html: a.html }));
    }
  } catch (e) {
    logger.error("alert_owner_email_failed", { type: a.type, error: (e as Error).message });
  }
  if (a.whatsappText) {
    try {
      await sendOwnerWhatsApp(a.whatsappText);
    } catch (e) {
      logger.error("alert_owner_whatsapp_failed", { type: a.type, error: (e as Error).message });
    }
  }
}

/**
 * Outbound WhatsApp to the owner via the Meta WhatsApp Business Cloud API.
 * DORMANT until WHATSAPP_TOKEN + WHATSAPP_PHONE_ID + WHATSAPP_OWNER_TO are set;
 * until then it logs a skip so the alert path never breaks. (The owner must
 * provision a WhatsApp Business API number + token — a wa.me link is NOT a push.)
 */
export async function sendOwnerWhatsApp(text: string): Promise<void> {
  const token = env.WHATSAPP_TOKEN;
  const phoneId = env.WHATSAPP_PHONE_ID;
  const to = env.WHATSAPP_OWNER_TO;
  if (!token || !phoneId || !to) {
    logger.info("whatsapp_skipped_not_configured", {});
    return;
  }
  const res = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text } }),
  });
  if (!res.ok) throw new Error(`whatsapp api ${res.status}`);
}
