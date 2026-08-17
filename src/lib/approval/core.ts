/**
 * The channel-agnostic approval loop (spec 2026-08-17). createApprovalRequest
 * is BEST-EFFORT: it runs after desk-mode booking creation and must never
 * break it. applyDecision is the single decision funnel for every channel
 * (telegram tap, email link, admin button): row lock + guarded status flip =
 * first tap wins, everyone else gets an honest "already handled by X".
 */
import { and, eq } from "drizzle-orm";
import { env } from "@/env";
import { getDb } from "@/lib/db/client";
import { approvalRequests, bookings, type ApprovalDelivery, type ApprovalRequest } from "@/lib/db/schema";
import { getSettings } from "@/lib/admin/settings";
import { buildApprovalMessage } from "@/lib/approval/message";
import { issueApprovalToken, verifyApprovalToken, hashToken } from "@/lib/approval/tokens";
import { telegramConfigured, sendApprovalMessage } from "@/lib/approval/telegram";
import { approvalDecisionEmail } from "@/lib/email/templates";
import { sendToMany } from "@/lib/email/send";
import { notifyBookingConfirmed, notifyBookingCancelled } from "@/lib/email/notifications";
import { notifyAdmin } from "@/lib/notify";
import { audit } from "@/lib/audit";
import { siteConfig } from "@/lib/site-config";
import { logger } from "@/lib/logger";

const TOKEN_TTL_MS = 7 * 86_400_000;

export type DecisionAction = "confirm" | "decline";
export interface DecisionActor { name: string; channel: "telegram" | "email" | "admin" }
export type DecisionOutcome =
  | { outcome: "confirmed" | "declined"; bookingId: string; request: ApprovalRequest }
  | { outcome: "already_handled"; decidedBy: string | null; bookingId: string | null }
  | { outcome: "expired" }
  | { outcome: "not_found" };

export async function createApprovalRequest(bookingId: string): Promise<void> {
  try {
    if (env.PAYMENT_MODE !== "desk") return;
    const msg = await buildApprovalMessage(bookingId);
    if (!msg) return;
    const db = await getDb();
    const [request] = await db.insert(approvalRequests).values({
      bookingId,
      tokenHash: "issuing",
      expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
    }).returning();
    if (!request) return;
    // Persist the real hash BEFORE any send goes out: if Telegram or email
    // fails midway, links already delivered still verify against the row
    // instead of stranding it on the "issuing" placeholder.
    const token = issueApprovalToken(request.id);
    await db.update(approvalRequests)
      .set({ tokenHash: hashToken(token), updatedAt: new Date() })
      .where(eq(approvalRequests.id, request.id));
    const settings = await getSettings();
    const deliveries: ApprovalDelivery[] = [];

    if (telegramConfigured()) {
      for (const m of settings.approvalManagers.filter((m) => m.chatId)) {
        try {
          const messageId = await sendApprovalMessage(m.chatId!, msg.text, request.id);
          deliveries.push({ channel: "telegram", to: m.chatId!, messageId: messageId ?? undefined, sentAt: new Date().toISOString() });
        } catch (e) {
          logger.error("approval_telegram_send_failed", { bookingId, chatId: m.chatId, error: (e as Error).message });
        }
      }
    }

    try {
      const emails = settings.approvalManagers.map((m) => m.email).filter((e): e is string => Boolean(e));
      if (emails.length) {
        const approveUrl = `${env.APP_ORIGIN}/approve/${token}?action=confirm`;
        const declineUrl = `${env.APP_ORIGIN}/approve/${token}?action=decline`;
        await sendToMany(emails, (to) => ({
          to, type: "approval_decision",
          ...approvalDecisionEmail({ siteName: siteConfig.siteName, messageText: msg.text, approveUrl, declineUrl }),
        }));
        for (const to of emails) deliveries.push({ channel: "email", to, sentAt: new Date().toISOString() });
      }
    } catch (e) {
      logger.error("approval_email_send_failed", { bookingId, error: (e as Error).message });
    }

    await db.update(approvalRequests)
      .set({ sentTo: deliveries, updatedAt: new Date() })
      .where(eq(approvalRequests.id, request.id));

    await notifyAdmin({
      level: "info", type: "approval.requested", title: "Booking waiting for approval",
      body: msg.fleetLine, bookingId,
    });
  } catch (e) {
    logger.error("approval_request_failed", { bookingId, error: (e as Error).message });
  }
}

export async function applyDecision(requestId: string, action: DecisionAction, actor: DecisionActor): Promise<DecisionOutcome> {
  const db = await getDb();
  const result = await db.transaction(async (tx): Promise<DecisionOutcome> => {
    const [row] = await tx.select().from(approvalRequests).where(eq(approvalRequests.id, requestId)).for("update");
    if (!row) return { outcome: "not_found" };
    if (row.status !== "open") return { outcome: "already_handled", decidedBy: row.decidedBy, bookingId: row.bookingId };
    if (row.expiresAt.getTime() < Date.now()) {
      await tx.update(approvalRequests).set({ status: "closed", updatedAt: new Date() }).where(eq(approvalRequests.id, requestId));
      return { outcome: "expired" };
    }
    const to = action === "confirm" ? "confirmed" : "cancelled";
    const flipped = await tx.update(bookings)
      .set({ status: to, updatedAt: new Date() })
      .where(and(eq(bookings.id, row.bookingId), eq(bookings.status, "pending")))
      .returning({ id: bookings.id });
    if (flipped.length === 0) {
      // Someone decided the booking elsewhere (admin) while the ping was out.
      await tx.update(approvalRequests).set({ status: "closed", updatedAt: new Date() }).where(eq(approvalRequests.id, requestId));
      return { outcome: "already_handled", decidedBy: null, bookingId: row.bookingId };
    }
    const [updated] = await tx.update(approvalRequests).set({
      status: action === "confirm" ? "confirmed" : "declined",
      decidedBy: actor.name, decidedChannel: actor.channel, decidedAt: new Date(), updatedAt: new Date(),
    }).where(eq(approvalRequests.id, requestId)).returning();
    return { outcome: action === "confirm" ? "confirmed" : "declined", bookingId: row.bookingId, request: updated! };
  });

  if (result.outcome === "confirmed") {
    await notifyBookingConfirmed(result.bookingId).catch(() => undefined);
    await audit({ actor: `approval:${actor.name}`, action: "approval.confirmed", entity: "booking", entityId: result.bookingId, after: { channel: actor.channel } }).catch(() => undefined);
  } else if (result.outcome === "declined") {
    await notifyBookingCancelled(result.bookingId, { refunded: false, refundCents: 0 }).catch(() => undefined);
    await audit({ actor: `approval:${actor.name}`, action: "approval.declined", entity: "booking", entityId: result.bookingId, after: { channel: actor.channel } }).catch(() => undefined);
  }
  return result;
}

/** Email-link entry: verifies the HMAC signature AND that the token matches
 *  the stored hash (constant-format sha256 compare) before deciding. */
export async function applyDecisionByToken(token: string, action: DecisionAction): Promise<DecisionOutcome> {
  const requestId = verifyApprovalToken(token);
  if (!requestId) return { outcome: "not_found" };
  const db = await getDb();
  const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, requestId));
  if (!row || row.tokenHash !== hashToken(token)) return { outcome: "not_found" };
  return applyDecision(requestId, action, { name: "Email approver", channel: "email" });
}

/** Read a request plus enough booking context for the email review page. */
export async function getApprovalSummary(token: string): Promise<{ request: ApprovalRequest; message: string } | null> {
  const requestId = verifyApprovalToken(token);
  if (!requestId) return null;
  const db = await getDb();
  const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, requestId));
  if (!row || row.tokenHash !== hashToken(token)) return null;
  const msg = await buildApprovalMessage(row.bookingId);
  return msg ? { request: row, message: msg.text } : null;
}
