/**
 * Best-effort transactional email. Sends via Resend when configured, ALWAYS
 * records the attempt in email_log (spec §9), and NEVER throws into the calling
 * flow — a failed email can't break a booking or a payment confirmation.
 */
import { getDb } from "@/lib/db/client";
import { emailLog } from "@/lib/db/schema";
import { env } from "@/env";
import { logger } from "@/lib/logger";
import { getResend } from "@/lib/email/resend-client";

export interface OutboundEmail {
  to: string;
  type: string; // e.g. "login_code", "booking_confirmed", "admin_new_booking"
  subject: string;
  html: string;
  /** Optional attachments (base64 content), e.g. the rental contract PDF. */
  attachments?: Array<{ filename: string; content: string }>;
}

export type SendStatus = "sent" | "failed" | "skipped";

async function recordLog(to: string, type: string, status: SendStatus, providerId: string | null): Promise<void> {
  try {
    const db = await getDb();
    await db.insert(emailLog).values({ to, type, status, providerId });
  } catch (e) {
    logger.error("email_log_write_failed", { type, error: (e as Error).message });
  }
}

export async function sendAndLog(msg: OutboundEmail): Promise<SendStatus> {
  const resend = getResend();
  if (!resend) {
    await recordLog(msg.to, msg.type, "skipped", null);
    return "skipped";
  }
  try {
    const { data, error } = await resend.emails.send({
      from: env.EMAIL_FROM,
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
      ...(msg.attachments ? { attachments: msg.attachments } : {}),
    });
    if (error) {
      logger.error("email_send_failed", { type: msg.type, error: error.message });
      await recordLog(msg.to, msg.type, "failed", null);
      return "failed";
    }
    await recordLog(msg.to, msg.type, "sent", data?.id ?? null);
    return "sent";
  } catch (e) {
    logger.error("email_send_threw", { type: msg.type, error: (e as Error).message });
    await recordLog(msg.to, msg.type, "failed", null);
    return "failed";
  }
}

/** Fan out one email to several recipients (admin alerts). */
export async function sendToMany(recipients: string[], build: (to: string) => OutboundEmail): Promise<void> {
  await Promise.all(recipients.map((to) => sendAndLog(build(to))));
}
