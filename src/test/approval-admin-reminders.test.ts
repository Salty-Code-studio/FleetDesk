process.env.PAYMENT_MODE = "desk";
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_WEBHOOK_SECRET;
process.env.TELEGRAM_BOT_TOKEN = "123:testtoken";
process.env.TELEGRAM_WEBHOOK_SECRET = "hook-secret-1";
// The cron env freezes at first import of "@/env", so this must be set here,
// before any dynamic import below pulls that module in transitively.
process.env.CRON_SECRET = "cron-secret-for-tests";

import { describe, it, expect, beforeAll, vi } from "vitest";
import type { Db } from "@/lib/db/client";

// Empty cookie jar: every route call in this file that goes through
// requireAdmin sees no session cookie, exactly like a real unauthenticated
// request. Only the HTTP-boundary test at the bottom exercises this path; the
// admin-confirm tests above it call confirmBookingAdmin directly (lib-level).
const cookieJar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { value: cookieJar.get(name)! } : undefined),
  }),
}));

const telegramCalls: Array<{ method: string; body: Record<string, unknown> }> = [];
vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
  const u = String(url);
  if (u.includes("api.telegram.org")) {
    telegramCalls.push({ method: u.split("/").pop()!, body: JSON.parse((init?.body as string) ?? "{}") });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 700 } }), { status: 200 });
  }
  return new Response("{}", { status: 200 });
}));

let db: Db;
let bookingId = "";
let requestId = "";
let secondBookingId = "";
let secondRequestId = "";
let thirdBookingId = "";
let thirdRequestId = "";

beforeAll(async () => {
  const { runMigrations } = await import("@/lib/db/migrate");
  await runMigrations();
  const { getDb } = await import("@/lib/db/client");
  db = await getDb();
  const { approvalRequests, bookings, customers, vehicles } = await import("@/lib/db/schema");
  const { patchSettings } = await import("@/lib/admin/settings");
  const { createApprovalRequest } = await import("@/lib/approval/core");
  const { eq } = await import("drizzle-orm");

  await patchSettings({
    approvalManagers: [{ name: "Naomi", inviteCode: "code-naomi-adm-1", chatId: "777" }],
  });

  const [customer] = await db.insert(customers).values({ email: "adm-reminders@example.com", name: "Adm Cust", phone: "" }).returning();

  async function seedPendingBooking(slug: string, key: string) {
    const [v] = await db.insert(vehicles).values({
      slug, plate: slug.toUpperCase(), name: `Car ${slug}`, class: "Jeep", status: "active",
      seats: 5, transmission: "Automatic", doors: 5,
      priceDayCents: 7000, priceWeekCents: 40000, priceMonthCents: 120000,
    }).returning();
    const [b] = await db.insert(bookings).values({
      vehicleId: v!.id, customerId: customer!.id,
      startAt: "2027-09-01T10:00:00-04:00", endAt: "2027-09-03T10:00:00-04:00",
      bufferEndAt: "2027-09-04T10:00:00-04:00", status: "pending",
      priceBreakdown: { subtotalCents: 14000, currency: "USD" }, paymentOption: "full",
      acceptedPolicyVersion: 0, acceptedAt: new Date(), idempotencyKey: key,
    }).returning();
    return b!.id;
  }

  bookingId = await seedPendingBooking("adm-car-1", "adm-key-1");
  await createApprovalRequest(bookingId);
  const [row1] = await db.select().from(approvalRequests).where(eq(approvalRequests.bookingId, bookingId));
  requestId = row1!.id;

  secondBookingId = await seedPendingBooking("adm-car-2", "adm-key-2");
  await createApprovalRequest(secondBookingId);
  const [row2] = await db.select().from(approvalRequests).where(eq(approvalRequests.bookingId, secondBookingId));
  secondRequestId = row2!.id;

  thirdBookingId = await seedPendingBooking("adm-car-3", "adm-key-3");
  await createApprovalRequest(thirdBookingId);
  const [row3] = await db.select().from(approvalRequests).where(eq(approvalRequests.bookingId, thirdBookingId));
  thirdRequestId = row3!.id;
});

describe("admin confirm + reminders", () => {
  it("admin confirm flips the booking, closes the request, edits the pings", async () => {
    const { confirmBookingAdmin } = await import("@/lib/admin/confirm-booking");
    const { approvalRequests, bookings } = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");

    const res = await confirmBookingAdmin(bookingId, "Desk admin");
    expect(res.status).toBe("confirmed");
    expect(res.id).toBe(bookingId);

    const [bookingRow] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
    expect(bookingRow!.status).toBe("confirmed");

    const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.bookingId, bookingId));
    expect(row!.id).toBe(requestId);
    expect(row!.status).toBe("confirmed");
    expect(row!.decidedChannel).toBe("admin");
    expect(row!.decidedBy).toBe("Desk admin");

    const edit = telegramCalls.find((c) => c.method === "editMessageText" && c.body.chat_id === "777");
    expect(edit).toBeDefined();
    expect(String(edit!.body.text)).toContain("Confirmed by Desk admin");
  });

  it("admin confirm without an open approval request does a guarded flip and emails the customer", async () => {
    const { confirmBookingAdmin } = await import("@/lib/admin/confirm-booking");
    const { approvalRequests, bookings, customers, vehicles, emailLog } = await import("@/lib/db/schema");
    const { eq, and } = await import("drizzle-orm");

    const [v] = await db.insert(vehicles).values({
      slug: "adm-car-noreq", plate: "ADM-NOREQ", name: "Car No Req", class: "Jeep", status: "active",
      seats: 5, transmission: "Automatic", doors: 5,
      priceDayCents: 7000, priceWeekCents: 40000, priceMonthCents: 120000,
    }).returning();
    const [c] = await db.insert(customers).values({ email: "adm-noreq@example.com", name: "No Req Cust", phone: "" }).returning();
    const [b] = await db.insert(bookings).values({
      vehicleId: v!.id, customerId: c!.id,
      startAt: "2027-09-01T10:00:00-04:00", endAt: "2027-09-03T10:00:00-04:00",
      bufferEndAt: "2027-09-04T10:00:00-04:00", status: "pending",
      priceBreakdown: { subtotalCents: 14000, currency: "USD" }, paymentOption: "full",
      acceptedPolicyVersion: 0, acceptedAt: new Date(), idempotencyKey: "adm-key-noreq",
    }).returning();

    const res = await confirmBookingAdmin(b!.id, "Desk admin");
    expect(res.status).toBe("confirmed");

    const [bookingRow] = await db.select().from(bookings).where(eq(bookings.id, b!.id));
    expect(bookingRow!.status).toBe("confirmed");

    // Never had an approval request: proves confirmBookingAdmin took the
    // guarded-flip branch, not the applyDecision funnel.
    const [reqRow] = await db.select().from(approvalRequests).where(eq(approvalRequests.bookingId, b!.id));
    expect(reqRow).toBeUndefined();

    const [log] = await db.select().from(emailLog)
      .where(and(eq(emailLog.to, "adm-noreq@example.com"), eq(emailLog.type, "booking_confirmed")));
    expect(log).toBeDefined();
  });

  it("confirming a non-pending booking throws a conflict", async () => {
    const { confirmBookingAdmin } = await import("@/lib/admin/confirm-booking");
    const { bookings, customers, vehicles } = await import("@/lib/db/schema");
    const { expectReject } = await import("./util");

    const [v] = await db.insert(vehicles).values({
      slug: "adm-car-conflict", plate: "ADM-CONF", name: "Car Conflict", class: "Jeep", status: "active",
      seats: 5, transmission: "Automatic", doors: 5,
      priceDayCents: 7000, priceWeekCents: 40000, priceMonthCents: 120000,
    }).returning();
    const [c] = await db.insert(customers).values({ email: "adm-conflict@example.com", name: "Conflict Cust", phone: "" }).returning();
    const [b] = await db.insert(bookings).values({
      vehicleId: v!.id, customerId: c!.id,
      startAt: "2027-09-01T10:00:00-04:00", endAt: "2027-09-03T10:00:00-04:00",
      bufferEndAt: "2027-09-04T10:00:00-04:00", status: "cancelled",
      priceBreakdown: { subtotalCents: 14000, currency: "USD" }, paymentOption: "full",
      acceptedPolicyVersion: 0, acceptedAt: new Date(), idempotencyKey: "adm-key-conflict",
    }).returning();

    await expectReject(confirmBookingAdmin(b!.id, "Desk admin"), /pending/i);
  });

  it("reminder pings once, then respects the max", async () => {
    const { approvalRequests } = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");
    // Backdate createdAt beyond approvalReminderHours (default 4h).
    await db.update(approvalRequests).set({ createdAt: new Date(Date.now() - 5 * 3600_000) }).where(eq(approvalRequests.id, secondRequestId));

    const { runApprovalReminders } = await import("@/lib/approval/reminders");
    const first = await runApprovalReminders();
    expect(first.reminded).toBe(1);

    const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, secondRequestId));
    expect(row!.reminderCount).toBe(1);
    expect(row!.remindedAt).not.toBeNull();
    expect(row!.sentTo.length).toBe(2); // original send (createApprovalRequest) + this reminder

    const reminderPings = telegramCalls.filter((c) =>
      c.method === "sendMessage" && c.body.chat_id === "777" && String(c.body.text).startsWith("Reminder: "),
    );
    expect(reminderPings).toHaveLength(1);

    const again = await runApprovalReminders();
    expect(again.reminded).toBe(0); // maxReminders default 1

    // Discriminating: prove the cap actually suppressed a second SEND, not
    // merely that the counter reads 0 while a message went out anyway.
    const reminderPingsAfter = telegramCalls.filter((c) =>
      c.method === "sendMessage" && c.body.chat_id === "777" && String(c.body.text).startsWith("Reminder: "),
    );
    expect(reminderPingsAfter).toHaveLength(1);

    const [rowAfter] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, secondRequestId));
    expect(rowAfter!.reminderCount).toBe(1); // unchanged by the capped second run
  });

  it("janitor closes requests whose booking got decided elsewhere, and only that one", async () => {
    const { approvalRequests, bookings } = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");
    await db.update(bookings).set({ status: "cancelled" }).where(eq(bookings.id, thirdBookingId));

    const { runApprovalReminders } = await import("@/lib/approval/reminders");
    const res = await runApprovalReminders();
    expect(res.closed).toBe(1);

    const [thirdRow] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, thirdRequestId));
    expect(thirdRow!.status).toBe("closed");

    // Discriminating: the still-pending request (already at its reminder cap
    // from the previous test) must be untouched by the janitor sweep, proving
    // only the genuinely stale request closed.
    const [secondRow] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, secondRequestId));
    expect(secondRow!.status).toBe("open");
  });

  it("cron route requires the secret", async () => {
    const { GET } = await import("@/app/api/cron/approval-reminders/route");
    const no = await GET(new Request("http://localhost:3000/api/cron/approval-reminders"));
    expect(no.status).toBe(401);
    const ok = await GET(new Request("http://localhost:3000/api/cron/approval-reminders", { headers: { authorization: "Bearer cron-secret-for-tests" } }));
    expect(ok.status).toBe(200);
  });

  it("POST /api/admin/bookings/:id/confirm requires an authenticated session", async () => {
    // No cookie set in cookieJar: mirrors how every other admin route
    // rejects an unauthenticated caller (requireAdmin -> Errors.unauthorized -> 401).
    const { POST } = await import("@/app/api/admin/bookings/[id]/confirm/route");
    const req = new Request(`http://localhost:3000/api/admin/bookings/${bookingId}/confirm`, {
      method: "POST",
      headers: { origin: "http://localhost:3000" },
    });
    const res = await POST(req, { params: Promise.resolve({ id: bookingId }) });
    expect(res.status).toBe(401);
  });
});
