process.env.PAYMENT_MODE = "desk";
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_WEBHOOK_SECRET;
process.env.TELEGRAM_BOT_TOKEN = "123:testtoken";
process.env.TELEGRAM_WEBHOOK_SECRET = "hook-secret-2";

import { describe, it, expect, beforeAll, vi } from "vitest";

const telegramCalls: Array<{ method: string; body: Record<string, unknown> }> = [];
vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
  const u = String(url);
  if (u.includes("api.telegram.org")) {
    telegramCalls.push({ method: u.split("/").pop()!, body: JSON.parse((init?.body as string) ?? "{}") });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 900 } }), { status: 200 });
  }
  return new Response("{}", { status: 200 });
}));

let bookingId = "";
let token = "";

beforeAll(async () => {
  const { runMigrations } = await import("@/lib/db/migrate");
  await runMigrations();
  const { getDb } = await import("@/lib/db/client");
  const { approvalRequests, bookings, customers, vehicles } = await import("@/lib/db/schema");
  const { patchSettings } = await import("@/lib/admin/settings");
  const { createApprovalRequest } = await import("@/lib/approval/core");
  const { issueApprovalToken } = await import("@/lib/approval/tokens");
  const { eq } = await import("drizzle-orm");
  // A manager with BOTH chatId and email so createApprovalRequest exercises the
  // email delivery path (not just Telegram) while seeding.
  await patchSettings({
    approvalManagers: [
      { name: "Dana", inviteCode: "code-dana-1", chatId: "911", email: "dana@example.com" },
    ],
  });
  const db = await getDb();
  const [v] = await db.insert(vehicles).values({
    slug: "email-car", plate: "EM-1", name: "Email Car", class: "Sedan", status: "active",
    seats: 5, transmission: "Automatic", doors: 4,
    priceDayCents: 6000, priceWeekCents: 35000, priceMonthCents: 100000,
  }).returning();
  await db.insert(customers).values({ email: "email-cust@example.com", name: "Email Cust", phone: "" });
  const [c] = await db.select().from(customers).where(eq(customers.email, "email-cust@example.com"));
  const [b] = await db.insert(bookings).values({
    vehicleId: v!.id, customerId: c!.id,
    startAt: "2027-11-01T10:00:00-04:00", endAt: "2027-11-03T10:00:00-04:00",
    bufferEndAt: "2027-11-04T10:00:00-04:00", status: "pending",
    priceBreakdown: { subtotalCents: 12000, currency: "USD" }, paymentOption: "full",
    acceptedPolicyVersion: 0, acceptedAt: new Date(), idempotencyKey: "email-key-1",
  }).returning();
  bookingId = b!.id;
  await createApprovalRequest(bookingId);
  const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.bookingId, bookingId));
  // Regenerate the deterministic token rather than parsing it out of a sent
  // email/telegram payload: issueApprovalToken is a pure HMAC of the request
  // id, so this equals the one createApprovalRequest actually issued.
  token = issueApprovalToken(row!.id);
});

describe("email decision endpoints", () => {
  it("GET summary returns the message for a valid token and 404 for garbage", async () => {
    const { GET } = await import("@/app/api/approval/[token]/route");
    const ok = await GET(new Request("http://localhost:3000/api/approval/x", { headers: { "user-agent": "t" } }), { params: Promise.resolve({ token }) });
    expect(ok.status).toBe(200);
    expect((await ok.json()).status).toBe("open");
    const bad = await GET(new Request("http://localhost:3000/api/approval/x", { headers: { "user-agent": "t" } }), { params: Promise.resolve({ token: "garbage" }) });
    expect(bad.status).toBe(404);
    // scanner-safety: the GET calls above must not have decided anything
    const { getDb } = await import("@/lib/db/client");
    const { approvalRequests, bookings } = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");
    const db = await getDb();
    const [reqRow] = await db.select().from(approvalRequests).where(eq(approvalRequests.bookingId, bookingId));
    expect(reqRow!.status).toBe("open");
    expect(reqRow!.decidedBy).toBe(null);
    const [b] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
    expect(b!.status).toBe("pending");
  });

  it("POST decide confirms the booking once, then reports already handled", async () => {
    const { POST } = await import("@/app/api/approval/decide/route");
    const decide = (action: string) => POST(new Request("http://localhost:3000/api/approval/decide", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000", "user-agent": "t" },
      body: JSON.stringify({ token, action }),
    }), { params: Promise.resolve({}) });
    const first = await decide("confirm");
    expect((await first.json()).outcome).toBe("confirmed");
    const second = await decide("decline");
    expect((await second.json()).outcome).toBe("already_handled");
    const { getDb } = await import("@/lib/db/client");
    const { bookings } = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");
    const db = await getDb();
    const [b] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
    // Discriminating: the second (decline) call must NOT flip the already
    // decided booking back to cancelled. First-decision-wins.
    expect(b!.status).toBe("confirmed");
  });
});
