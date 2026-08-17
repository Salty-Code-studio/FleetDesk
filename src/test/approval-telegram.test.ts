import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseTelegramUpdate, sendApprovalMessage, sendText, editMessage, answerCallback } from "@/lib/approval/telegram";

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
  it("rejects /start lookalikes and accepts bare /start", () => {
    expect(parseTelegramUpdate({ update_id: 6, message: { message_id: 1, from: { id: 1, first_name: "A" }, chat: { id: 1 }, text: "/startxyz" } })).toBeNull();
    expect(parseTelegramUpdate({ update_id: 7, message: { message_id: 1, from: { id: 1, first_name: "A" }, chat: { id: 1 }, text: "/startgroup somecode" } })).toBeNull();
    expect(parseTelegramUpdate({ update_id: 8, message: { message_id: 1, from: { id: 9, first_name: "B" }, chat: { id: 9 }, text: "/start" } })).toEqual({
      kind: "start", chatId: "9", fromName: "B", code: "",
    });
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

describe("outbound payload shapes", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }),
    ));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  function lastCall(): { url: string; body: Record<string, unknown> } {
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    return { url: String(url), body: JSON.parse((init as RequestInit).body as string) as Record<string, unknown> };
  }

  it("editMessage posts an explicit empty inline keyboard", async () => {
    await editMessage("777", 42, "hello");
    const { url, body } = lastCall();
    expect(url).toContain("/editMessageText");
    expect(body.chat_id).toBe("777");
    expect(body.message_id).toBe(42);
    expect(body.text).toBe("hello");
    expect(body.reply_markup).toEqual({ inline_keyboard: [] });
  });

  it("answerCallback posts the text when given", async () => {
    await answerCallback("cb1", "Done.");
    const { url, body } = lastCall();
    expect(url).toContain("/answerCallbackQuery");
    expect(body.callback_query_id).toBe("cb1");
    expect(body.text).toBe("Done.");
  });

  it("answerCallback omits the text key when not given", async () => {
    await answerCallback("cb2");
    const { url, body } = lastCall();
    expect(url).toContain("/answerCallbackQuery");
    expect(body.callback_query_id).toBe("cb2");
    expect("text" in body).toBe(false);
  });

  it("sendText posts a plain message without reply_markup", async () => {
    await sendText("777", "hi");
    const { url, body } = lastCall();
    expect(url).toContain("/sendMessage");
    expect(body.chat_id).toBe("777");
    expect(body.text).toBe("hi");
    expect("reply_markup" in body).toBe(false);
  });
});
