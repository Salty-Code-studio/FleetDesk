import { timingSafeEqual, createHash } from "node:crypto";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { Errors } from "@/lib/http/errors";
import { enforceRateLimit } from "@/lib/http/rate-limit";
import { env } from "@/env";
import { parseTelegramUpdate, answerCallback, sendText } from "@/lib/approval/telegram";
import { linkManagerChat, managerByChatId } from "@/lib/approval/linking";
import { applyDecision } from "@/lib/approval/core";
import { broadcastDecision } from "@/lib/approval/broadcast";
import { siteConfig } from "@/lib/site-config";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Constant-time secret compare. Hashing both values first makes them equal
 *  length (a sha256 digest is always 32 bytes), so timingSafeEqual never
 *  throws on a length mismatch and never leaks the real secret's length via
 *  timing either. */
function secretsMatch(a: string, b: string): boolean {
  const ah = createHash("sha256").update(a).digest();
  const bh = createHash("sha256").update(b).digest();
  return timingSafeEqual(ah, bh);
}

/**
 * POST /api/webhooks/telegram: the deployment's own bot webhook. Trust model:
 * the X-Telegram-Bot-Api-Secret-Token header must equal OUR random secret
 * (set via scripts/telegram-setup.ts), and a tap only counts when the chat id
 * belongs to a linked manager. Always 200 fast on handled updates so Telegram
 * does not retry into a loop; unknown senders are answered politely and logged.
 */
export const POST = withRoute(async (req) => {
  const provided = req.headers.get("x-telegram-bot-api-secret-token");
  if (!env.TELEGRAM_WEBHOOK_SECRET || !provided || !secretsMatch(provided, env.TELEGRAM_WEBHOOK_SECRET)) {
    throw Errors.notFound("Not found"); // do not reveal the endpoint
  }
  await enforceRateLimit(req, "global", "public");
  const update = await req.json().catch(() => null);
  const parsed = parseTelegramUpdate(update);
  if (!parsed) return json({ ok: true }, req);

  if (parsed.kind === "start") {
    const manager = await linkManagerChat(parsed.code, parsed.chatId);
    const reply = manager
      ? `You're linked, ${manager.name}. Booking approvals for ${siteConfig.siteName} will arrive here.`
      : `This bot only serves ${siteConfig.siteName} staff. Ask your admin for an invite link.`;
    await sendText(parsed.chatId, reply).catch((e) => logger.error("telegram_start_reply_failed", { error: (e as Error).message }));
    return json({ ok: true }, req);
  }

  const manager = await managerByChatId(parsed.chatId);
  if (!manager) {
    logger.warn("telegram_tap_unknown_chat", { chatId: parsed.chatId });
    await answerCallback(parsed.callbackQueryId, "Not authorized.").catch((e) => logger.error("telegram_answer_failed", { error: (e as Error).message }));
    return json({ ok: true }, req);
  }

  const result = await applyDecision(parsed.requestId, parsed.action, { name: manager.name, channel: "telegram" });
  if (result.outcome === "confirmed" || result.outcome === "declined") {
    await answerCallback(parsed.callbackQueryId, result.outcome === "confirmed" ? "Booking confirmed." : "Booking declined.").catch((e) => logger.error("telegram_answer_failed", { error: (e as Error).message }));
    await broadcastDecision(parsed.requestId);
  } else if (result.outcome === "already_handled") {
    await answerCallback(parsed.callbackQueryId, `Already handled by ${result.decidedBy ?? "the team"}.`).catch((e) => logger.error("telegram_answer_failed", { error: (e as Error).message }));
  } else if (result.outcome === "expired") {
    await answerCallback(parsed.callbackQueryId, "This one expired. Please use the admin.").catch((e) => logger.error("telegram_answer_failed", { error: (e as Error).message }));
  } else {
    await answerCallback(parsed.callbackQueryId, "Unknown booking. Please use the admin.").catch((e) => logger.error("telegram_answer_failed", { error: (e as Error).message }));
  }
  return json({ ok: true }, req);
});
