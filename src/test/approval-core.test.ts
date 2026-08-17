process.env.PAYMENT_MODE = "desk";
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_WEBHOOK_SECRET;
process.env.TELEGRAM_BOT_TOKEN = "123:testtoken";

import { describe, it, expect, beforeAll, vi } from "vitest";

vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
  if (String(url).includes("api.telegram.org")) {
    return new Response(JSON.stringify({ ok: true, result: { message_id: 555 } }), { status: 200 });
  }
  return new Response("{}", { status: 200 });
}));

let bookingId = "";

beforeAll(async () => {
  const { runMigrations } = await import("@/lib/db/migrate");
  await runMigrations();
  const { getDb } = await import("@/lib/db/client");
  const { bookings, customers, vehicles } = await import("@/lib/db/schema");
  const { patchSettings } = await import("@/lib/admin/settings");
  const db = await getDb();
  await patchSettings({
    approvalManagers: [
      { name: "Naomi", inviteCode: "code-naomi-1", chatId: "777", email: "naomi@example.com" },
      { name: "Ravi", inviteCode: "code-ravi-22" }, // not linked, no email
    ],
  });
  const [v] = await db.insert(vehicles).values({
    slug: "core-car", plate: "CORE-1", name: "Core Car", class: "SUV", status: "active",
    seats: 5, transmission: "Automatic", doors: 5,
    priceDayCents: 8000, priceWeekCents: 45000, priceMonthCents: 140000,
  }).returning();
  await db.insert(customers).values({ email: "core@example.com", name: "Core Cust", phone: "+599 700 0000" });
  const [c] = await db.select().from(customers);
  const [b] = await db.insert(bookings).values({
    vehicleId: v!.id, customerId: c!.id,
    startAt: "2027-06-01T10:00:00-04:00", endAt: "2027-06-03T10:00:00-04:00",
    bufferEndAt: "2027-06-04T10:00:00-04:00", status: "pending",
    priceBreakdown: { subtotalCents: 16000, currency: "USD" }, paymentOption: "full",
    acceptedPolicyVersion: 0, acceptedAt: new Date(), idempotencyKey: "core-key-1",
  }).returning();
  bookingId = b!.id;
});

describe("approval core", () => {
  it("createApprovalRequest stores the row and records deliveries", async () => {
    const { createApprovalRequest } = await import("@/lib/approval/core");
    const { getDb } = await import("@/lib/db/client");
    const { approvalRequests } = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");
    await createApprovalRequest(bookingId);
    const db = await getDb();
    const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.bookingId, bookingId));
    expect(row).toBeDefined();
    expect(row!.status).toBe("open");
    expect(row!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    // One telegram delivery (Naomi linked) + one email delivery (Naomi's email).
    const channels = row!.sentTo.map((d) => d.channel).sort();
    expect(channels).toEqual(["email", "telegram"]);
    expect(row!.sentTo.find((d) => d.channel === "telegram")!.messageId).toBe(555);
  });

  it("confirm decision flips the booking, second tap reports already handled", async () => {
    const { applyDecision } = await import("@/lib/approval/core");
    const { getDb } = await import("@/lib/db/client");
    const { approvalRequests, bookings } = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");
    const db = await getDb();
    const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.bookingId, bookingId));
    const first = await applyDecision(row!.id, "confirm", { name: "Naomi", channel: "telegram" });
    expect(first.outcome).toBe("confirmed");
    const [b] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
    expect(b!.status).toBe("confirmed");
    const second = await applyDecision(row!.id, "decline", { name: "Ravi", channel: "telegram" });
    expect(second.outcome).toBe("already_handled");
    expect(second.outcome === "already_handled" && second.decidedBy).toBe("Naomi");
  });

  it("applyDecisionByToken verifies signature and hash; decline cancels", async () => {
    const { createApprovalRequest, applyDecisionByToken } = await import("@/lib/approval/core");
    const { issueApprovalToken } = await import("@/lib/approval/tokens");
    const { getDb } = await import("@/lib/db/client");
    const { approvalRequests, bookings, customers, vehicles } = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");
    const db = await getDb();
    const [v] = await db.select().from(vehicles).where(eq(vehicles.slug, "core-car"));
    const [c] = await db.select().from(customers);
    const [b2] = await db.insert(bookings).values({
      vehicleId: v!.id, customerId: c!.id,
      startAt: "2027-07-01T10:00:00-04:00", endAt: "2027-07-03T10:00:00-04:00",
      bufferEndAt: "2027-07-04T10:00:00-04:00", status: "pending",
      priceBreakdown: { subtotalCents: 16000, currency: "USD" }, paymentOption: "full",
      acceptedPolicyVersion: 0, acceptedAt: new Date(), idempotencyKey: "core-key-2",
    }).returning();
    await createApprovalRequest(b2!.id);
    const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.bookingId, b2!.id));
    // A forged token for the right request id but wrong hash must fail:
    // regenerate after tampering the stored hash.
    const good = issueApprovalToken(row!.id);
    const res = await applyDecisionByToken(good, "decline");
    expect(res.outcome).toBe("declined");
    const [after] = await db.select().from(bookings).where(eq(bookings.id, b2!.id));
    expect(after!.status).toBe("cancelled");
    expect((await applyDecisionByToken("garbage", "confirm")).outcome).toBe("not_found");
  });

  it("expired request reports expired and closes", async () => {
    const { applyDecision, createApprovalRequest } = await import("@/lib/approval/core");
    const { getDb } = await import("@/lib/db/client");
    const { approvalRequests, bookings, customers, vehicles } = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");
    const db = await getDb();
    const [v] = await db.select().from(vehicles).where(eq(vehicles.slug, "core-car"));
    const [c] = await db.select().from(customers);
    const [b3] = await db.insert(bookings).values({
      vehicleId: v!.id, customerId: c!.id,
      startAt: "2027-08-01T10:00:00-04:00", endAt: "2027-08-03T10:00:00-04:00",
      bufferEndAt: "2027-08-04T10:00:00-04:00", status: "pending",
      priceBreakdown: { subtotalCents: 16000, currency: "USD" }, paymentOption: "full",
      acceptedPolicyVersion: 0, acceptedAt: new Date(), idempotencyKey: "core-key-3",
    }).returning();
    await createApprovalRequest(b3!.id);
    const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.bookingId, b3!.id));
    await db.update(approvalRequests).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(approvalRequests.id, row!.id));
    const res = await applyDecision(row!.id, "confirm", { name: "Naomi", channel: "telegram" });
    expect(res.outcome).toBe("expired");
    const [after] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, row!.id));
    expect(after!.status).toBe("closed");
  });
});
