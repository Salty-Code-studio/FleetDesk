process.env.PAYMENT_MODE = "desk";
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_WEBHOOK_SECRET;
process.env.TELEGRAM_BOT_TOKEN = "123:testtoken";
process.env.TELEGRAM_WEBHOOK_SECRET = "hook-secret-1";

import { describe, it, expect, beforeAll, vi } from "vitest";

const telegramCalls: Array<{ method: string; body: Record<string, unknown> }> = [];
vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
  const u = String(url);
  if (u.includes("api.telegram.org")) {
    telegramCalls.push({ method: u.split("/").pop()!, body: JSON.parse((init?.body as string) ?? "{}") });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 700 } }), { status: 200 });
  }
  return new Response("{}", { status: 200 });
}));

let requestId = "";
let bookingId = "";

function hook(update: unknown, secret = "hook-secret-1") {
  return new Request("http://localhost:3000/api/webhooks/telegram", {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret, "user-agent": "tg" },
    body: JSON.stringify(update),
  });
}

beforeAll(async () => {
  const { runMigrations } = await import("@/lib/db/migrate");
  await runMigrations();
  const { getDb } = await import("@/lib/db/client");
  const { approvalRequests, bookings, customers, vehicles } = await import("@/lib/db/schema");
  const { patchSettings } = await import("@/lib/admin/settings");
  const { createApprovalRequest } = await import("@/lib/approval/core");
  const { eq } = await import("drizzle-orm");
  await patchSettings({
    approvalManagers: [
      { name: "Naomi", inviteCode: "code-naomi-1", chatId: "777" },
      { name: "Ravi", inviteCode: "code-ravi-22" },
    ],
  });
  const db = await getDb();
  const [v] = await db.insert(vehicles).values({
    slug: "tg-car", plate: "TG-1", name: "TG Car", class: "Jeep", status: "active",
    seats: 5, transmission: "Automatic", doors: 5,
    priceDayCents: 7000, priceWeekCents: 40000, priceMonthCents: 120000,
  }).returning();
  await db.insert(customers).values({ email: "tg@example.com", name: "TG Cust", phone: "" });
  const [c] = await db.select().from(customers);
  const [b] = await db.insert(bookings).values({
    vehicleId: v!.id, customerId: c!.id,
    startAt: "2027-09-01T10:00:00-04:00", endAt: "2027-09-03T10:00:00-04:00",
    bufferEndAt: "2027-09-04T10:00:00-04:00", status: "pending",
    priceBreakdown: { subtotalCents: 14000, currency: "USD" }, paymentOption: "full",
    acceptedPolicyVersion: 0, acceptedAt: new Date(), idempotencyKey: "tg-key-1",
  }).returning();
  bookingId = b!.id;
  await createApprovalRequest(bookingId);
  const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.bookingId, bookingId));
  requestId = row!.id;
});

describe("POST /api/webhooks/telegram", () => {
  it("rejects a wrong secret without touching anything", async () => {
    const { POST } = await import("@/app/api/webhooks/telegram/route");
    const res = await POST(hook({ update_id: 1 }, "wrong"), { params: Promise.resolve({}) });
    expect(res.status).toBe(404);
  });

  it("links a manager via /start invite code", async () => {
    const { POST } = await import("@/app/api/webhooks/telegram/route");
    const res = await POST(hook({
      update_id: 2,
      message: { message_id: 1, from: { id: 888, first_name: "Ravi" }, chat: { id: 888 }, text: "/start code-ravi-22" },
    }), { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const { getSettings } = await import("@/lib/admin/settings");
    const s = await getSettings();
    expect(s.approvalManagers.find((m) => m.name === "Ravi")!.chatId).toBe("888");
    // And the bot replied something warm to Ravi's chat.
    const reply = telegramCalls.find((c) => c.method === "sendMessage" && c.body.chat_id === "888");
    expect(reply).toBeDefined();
  });

  it("denies /start with a wrong or missing code and changes nothing", async () => {
    telegramCalls.length = 0;
    const { POST } = await import("@/app/api/webhooks/telegram/route");
    const { getSettings } = await import("@/lib/admin/settings");
    const before = (await getSettings()).approvalManagers;

    const res1 = await POST(hook({
      update_id: 6,
      message: { message_id: 2, from: { id: 555, first_name: "Mallory" }, chat: { id: 555 }, text: "/start wrong-code-999" },
    }), { params: Promise.resolve({}) });
    expect(res1.status).toBe(200);

    const res2 = await POST(hook({
      update_id: 7,
      message: { message_id: 3, from: { id: 555, first_name: "Mallory" }, chat: { id: 555 }, text: "/start" },
    }), { params: Promise.resolve({}) });
    expect(res2.status).toBe(200);

    // Both attempts got the polite denial, addressed to chat 555.
    const denials = telegramCalls.filter((c) =>
      c.method === "sendMessage" && c.body.chat_id === "555" &&
      String(c.body.text).includes("This bot only serves") && String(c.body.text).includes("staff"),
    );
    expect(denials).toHaveLength(2);

    // And the managers list is deep-equal untouched: nobody got linked.
    const after = (await getSettings()).approvalManagers;
    expect(after).toEqual(before);
    expect(after.some((m) => m.chatId === "555")).toBe(false);
  });

  it("ignores taps from unknown chats", async () => {
    telegramCalls.length = 0;
    const { POST } = await import("@/app/api/webhooks/telegram/route");
    const res = await POST(hook({
      update_id: 3,
      callback_query: { id: "cb-x", from: { id: 999, first_name: "Stranger" }, message: { message_id: 5, chat: { id: 999 } }, data: `apv:${requestId}:confirm` },
    }), { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const { getDb } = await import("@/lib/db/client");
    const { bookings, approvalRequests } = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");
    const db = await getDb();
    const [b] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
    expect(b!.status).toBe("pending"); // untouched
    // Discriminating: prove applyDecision itself never ran (not just that the
    // booking happens to still read pending) by checking the approval request
    // row is completely untouched too.
    const [reqRow] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, requestId));
    expect(reqRow!.status).toBe("open");
    expect(reqRow!.decidedBy).toBe(null);
    // The bot answered the tap (so Telegram stops spinning) but politely, and
    // never broadcast an edit (which only happens after a real decision).
    const answer = telegramCalls.find((c) => c.method === "answerCallbackQuery");
    expect(answer).toBeDefined();
    expect(String(answer!.body.text)).toContain("Not authorized");
    expect(telegramCalls.some((c) => c.method === "editMessageText")).toBe(false);
  });

  it("a linked manager's Confirm tap flips the booking and edits the pings", async () => {
    telegramCalls.length = 0;
    const { POST } = await import("@/app/api/webhooks/telegram/route");
    const res = await POST(hook({
      update_id: 4,
      callback_query: { id: "cb-1", from: { id: 777, first_name: "Naomi" }, message: { message_id: 700, chat: { id: 777 } }, data: `apv:${requestId}:confirm` },
    }), { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const { getDb } = await import("@/lib/db/client");
    const { bookings } = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");
    const db = await getDb();
    const [b] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
    expect(b!.status).toBe("confirmed");
    expect(telegramCalls.some((c) => c.method === "answerCallbackQuery")).toBe(true);
    const edit = telegramCalls.find((c) => c.method === "editMessageText");
    expect(edit).toBeDefined();
    expect(String(edit!.body.text)).toContain("Confirmed by Naomi");
  });

  it("a second tap answers already handled", async () => {
    const { POST } = await import("@/app/api/webhooks/telegram/route");
    telegramCalls.length = 0;
    await POST(hook({
      update_id: 5,
      callback_query: { id: "cb-2", from: { id: 888, first_name: "Ravi" }, message: { message_id: 701, chat: { id: 888 } }, data: `apv:${requestId}:decline` },
    }), { params: Promise.resolve({}) });
    const answer = telegramCalls.find((c) => c.method === "answerCallbackQuery");
    expect(String(answer!.body.text)).toContain("Already handled by Naomi");
  });
});
