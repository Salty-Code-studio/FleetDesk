/**
 * Minimal Telegram Bot API client for the approval loop. One bot PER
 * DEPLOYMENT (created with BotFather); this module only talks OUTBOUND.
 * Inbound updates arrive at /api/webhooks/telegram and are parsed with
 * parseTelegramUpdate (pure, unit-testable). callback_data is capped at 64
 * bytes by Telegram, so buttons carry only "apv:<requestId>:<action>";
 * AUTHORITY comes from the webhook secret header plus the linked manager
 * chat id, never from the button payload.
 */
import { env } from "@/env";

const CALLBACK_RE = /^apv:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(confirm|decline)$/;

export function telegramConfigured(): boolean {
  return Boolean(env.TELEGRAM_BOT_TOKEN);
}

async function call(method: string, payload: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`telegram ${method} ${res.status}`);
  const data = (await res.json()) as { ok: boolean; result?: unknown };
  if (!data.ok) throw new Error(`telegram ${method} not ok`);
  return data.result;
}

export async function sendApprovalMessage(chatId: string, text: string, requestId: string): Promise<number | null> {
  const result = await call("sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: {
      inline_keyboard: [[
        { text: "Confirm", callback_data: `apv:${requestId}:confirm` },
        { text: "Decline", callback_data: `apv:${requestId}:decline` },
      ]],
    },
  });
  const mid = (result as { message_id?: number } | undefined)?.message_id;
  return typeof mid === "number" ? mid : null;
}

export async function sendText(chatId: string, text: string): Promise<void> {
  await call("sendMessage", { chat_id: chatId, text });
}

/** Rewrites a delivered ping after the decision; omitting reply_markup drops
 *  the buttons so late taps have nothing left to press. */
export async function editMessage(chatId: string, messageId: number, text: string): Promise<void> {
  await call("editMessageText", { chat_id: chatId, message_id: messageId, text });
}

export async function answerCallback(callbackQueryId: string, text?: string): Promise<void> {
  await call("answerCallbackQuery", { callback_query_id: callbackQueryId, ...(text ? { text } : {}) });
}

export interface TelegramTap {
  kind: "tap";
  callbackQueryId: string;
  chatId: string;
  fromName: string;
  messageId: number;
  requestId: string;
  action: "confirm" | "decline";
}
export interface TelegramStart {
  kind: "start";
  chatId: string;
  fromName: string;
  code: string;
}

export function parseTelegramUpdate(update: unknown): TelegramTap | TelegramStart | null {
  if (!update || typeof update !== "object") return null;
  const u = update as Record<string, unknown>;

  const cq = u.callback_query as {
    id?: unknown; data?: unknown;
    from?: { id?: unknown; first_name?: unknown };
    message?: { message_id?: unknown; chat?: { id?: unknown } };
  } | undefined;
  if (cq && typeof cq.id === "string" && typeof cq.data === "string") {
    const m = CALLBACK_RE.exec(cq.data);
    const chatId = cq.message?.chat?.id;
    const messageId = cq.message?.message_id;
    if (m && (typeof chatId === "number" || typeof chatId === "string") && typeof messageId === "number") {
      return {
        kind: "tap",
        callbackQueryId: cq.id,
        chatId: String(chatId),
        fromName: typeof cq.from?.first_name === "string" ? cq.from.first_name : "Manager",
        messageId,
        requestId: m[1]!,
        action: m[2] as "confirm" | "decline",
      };
    }
    return null;
  }

  const msg = u.message as {
    text?: unknown;
    from?: { first_name?: unknown };
    chat?: { id?: unknown };
  } | undefined;
  if (msg && typeof msg.text === "string" && msg.text.startsWith("/start")) {
    const chatId = msg.chat?.id;
    if (typeof chatId !== "number" && typeof chatId !== "string") return null;
    return {
      kind: "start",
      chatId: String(chatId),
      fromName: typeof msg.from?.first_name === "string" ? msg.from.first_name : "there",
      code: msg.text.slice("/start".length).trim(),
    };
  }
  return null;
}
