import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseTelegramUpdate, sendApprovalMessage } from "@/lib/approval/telegram";

const RID = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("parseTelegramUpdate", () => {
  it("parses a Confirm button tap", () => {
    const tap = parseTelegramUpdate({
      update_id: 1,
      callback_query: {
        id: "cbq1", from: { id: 777, first_name: "Naomi" },
        message: { message_id: 42, chat: { id: 777 } },
        data: `apv:${RID}:confirm`,
      },
    });
    expect(tap).toEqual({
      kind: "tap", callbackQueryId: "cbq1", chatId: "777", fromName: "Naomi",
      messageId: 42, requestId: RID, action: "confirm",
    });
  });
  it("parses /start with an invite code", () => {
    const start = parseTelegramUpdate({
      update_id: 2,
      message: { message_id: 1, from: { id: 888, first_name: "Ravi" }, chat: { id: 888 }, text: "/start code-1234-abcd" },
    });
    expect(start).toEqual({ kind: "start", chatId: "888", fromName: "Ravi", code: "code-1234-abcd" });
  });
  it("returns null for junk, malformed callback data, and plain text", () => {
    expect(parseTelegramUpdate(null)).toBeNull();
    expect(parseTelegramUpdate({ update_id: 3 })).toBeNull();
    expect(parseTelegramUpdate({ update_id: 4, callback_query: { id: "x", from: { id: 1 }, message: { message_id: 1, chat: { id: 1 } }, data: "apv:not-a-uuid:confirm" } })).toBeNull();
    expect(parseTelegramUpdate({ update_id: 5, message: { message_id: 1, from: { id: 1, first_name: "A" }, chat: { id: 1 }, text: "hello" } })).toBeNull();
  });
});

describe("sendApprovalMessage", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("posts an inline keyboard and returns the message id", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }), { status: 200 }),
    );
    const mid = await sendApprovalMessage("777", "hello", RID);
    expect(mid).toBe(99);
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toContain("/sendMessage");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.chat_id).toBe("777");
    expect(body.reply_markup.inline_keyboard[0]).toEqual([
      { text: "Confirm", callback_data: `apv:${RID}:confirm` },
      { text: "Decline", callback_data: `apv:${RID}:decline` },
    ]);
  });
});
