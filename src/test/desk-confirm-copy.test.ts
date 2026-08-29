process.env.PAYMENT_MODE = "desk";
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_WEBHOOK_SECRET;
process.env.TELEGRAM_BOT_TOKEN = "123:desktesttoken";
process.env.TELEGRAM_WEBHOOK_SECRET = "hook-secret-desk-confirm";

import { describe, it, expect, beforeAll, vi } from "vitest";
import type { OutboundEmail } from "@/lib/email/send";

/**
 * Regression for the "desk confirmation claims payment" bug: a desk-mode
 * booking never takes an online payment, so the confirmed-booking email must
 * not say one came through. email_log only stores delivery status, never the
 * rendered subject/html, so this captures what notifyBookingConfirmed
 * actually sends the same way notifications-cancelled.test.ts does, instead
 * of reading the log table.
 */
const sendAndLog = vi.fn<(msg: OutboundEmail) => Promise<"skipped">>(async () => "skipped");
const sendToMany = vi.fn<(recipients: string[], build: (to: string) => OutboundEmail) => Promise<undefined>>(async () => undefined);
vi.mock("@/lib/email/send", () => ({
  sendAndLog: (msg: OutboundEmail) => sendAndLog(msg),
  sendToMany: (recipients: string[], build: (to: string) => OutboundEmail) => sendToMany(recipients, build),
}));

vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
  if (String(url).includes("api.telegram.org")) {
    return new Response(JSON.stringify({ ok: true, result: { message_id: 900 } }), { status: 200 });
  }
  return new Response("{}", { status: 200 });
}));

let requestId = "";

beforeAll(async () => {
  const { runMigrations } = await import("@/lib/db/migrate");
  await runMigrations();
  const { getDb } = await import("@/lib/db/client");
  const { approvalRequests, bookings, customers, vehicles } = await import("@/lib/db/schema");
  const { patchSettings } = await import("@/lib/admin/settings");
  const { createApprovalRequest } = await import("@/lib/approval/core");
  const { eq } = await import("drizzle-orm");

  await patchSettings({
    approvalManagers: [{ name: "Desk Manager", inviteCode: "code-desk-confirm-1", chatId: "424242" }],
    adminAlertRecipients: ["owner1@example.com", "owner2@example.com"],
  });

  const db = await getDb();
  const [v] = await db.insert(vehicles).values({
    slug: "desk-confirm-car", plate: "DESK-CONF", name: "Desk Confirm Car", class: "Jeep", status: "active",
    seats: 5, transmission: "Automatic", doors: 5,
    priceDayCents: 6000, priceWeekCents: 36000, priceMonthCents: 120000,
  }).returning();
  await db.insert(customers).values({ email: "desk-confirm@example.com", name: "Desk Cust", phone: "" });
  const [c] = await db.select().from(customers).where(eq(customers.email, "desk-confirm@example.com"));
  const [b] = await db.insert(bookings).values({
    vehicleId: v!.id, customerId: c!.id,
    startAt: "2027-10-01T10:00:00-04:00", endAt: "2027-10-03T10:00:00-04:00",
    bufferEndAt: "2027-10-04T10:00:00-04:00", status: "pending",
    priceBreakdown: { subtotalCents: 18000, currency: "USD" }, paymentOption: "full",
    acceptedPolicyVersion: 0, acceptedAt: new Date(), idempotencyKey: "desk-confirm-key-1",
  }).returning();

  await createApprovalRequest(b!.id);
  const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.bookingId, b!.id));
  requestId = row!.id;
});

describe("desk-mode confirmation copy", () => {
  it("confirming with no payment row sends a pay-at-pickup email, never claiming payment", async () => {
    const { applyDecision } = await import("@/lib/approval/core");
    sendAndLog.mockClear();
    sendToMany.mockClear();

    const result = await applyDecision(requestId, "confirm", { name: "Desk Manager", channel: "telegram" });
    expect(result.outcome).toBe("confirmed");

    const customerCall = sendAndLog.mock.calls.find((c) => c[0].type === "booking_confirmed");
    expect(customerCall).toBeDefined();
    const { html, subject } = customerCall![0];
    expect(html.toLowerCase()).not.toContain("payment");
    expect(subject.toLowerCase()).not.toContain("payment");
    expect(html).toContain("pay at pickup");

    // The owner also gets a "Reservation confirmed" copy, fanned out to every
    // configured recipient, on this exact same confirm funnel.
    expect(sendToMany).toHaveBeenCalledTimes(1);
    const [recipients, build] = sendToMany.mock.calls[0]!;
    expect(recipients).toEqual(["owner1@example.com", "owner2@example.com"]);
    const ownerEmail = build(recipients[0]!);
    expect(ownerEmail.type).toBe("admin_reservation_confirmed");
    expect(ownerEmail.subject.toLowerCase()).toContain("reservation confirmed");
    expect(ownerEmail.html.toLowerCase()).not.toContain("payment received");
    expect(ownerEmail.html).toContain("USD 180.00");
    expect(ownerEmail.html).toContain("desk-confirm@example.com");
    expect(ownerEmail.html).not.toMatch(/—|--/);
  });

  it("online wording (paid: true) is byte-for-byte unchanged", async () => {
    const { bookingConfirmedEmail } = await import("@/lib/email/templates");
    const { atAruba } = await import("@/lib/time/format");
    const online = bookingConfirmedEmail({
      bookingId: "aabbccdd-0000-0000-0000-000000000000",
      vehicleClass: "SUV", vehicleName: "Kia Sportage", customerName: "Pat Doe",
      startAt: atAruba("2027-01-01", "10:00"), endAt: atAruba("2027-01-05", "10:00"),
      rentalTotalCents: 18000, currency: "USD",
      amountPaidCents: 4000, chargeType: "rental_deposit",
      paid: true,
    });
    expect(online.html).toContain("Thanks, your payment came through and your car is reserved.");
  });

  // The "no-request admin fallback": confirmBookingAdmin's plain guarded flip,
  // taken when a booking has no OPEN approval request (an admin confirming
  // directly rather than acting on a Telegram/email decision). This path must
  // send the owner copy too, since it shares no code with applyDecision beyond
  // the notifyBookingConfirmed call both funnel through.
  it("the no-request admin fallback (confirmBookingAdmin, no open approval request) also sends the owner copy", async () => {
    const { getDb } = await import("@/lib/db/client");
    const { bookings, customers, vehicles } = await import("@/lib/db/schema");
    const { confirmBookingAdmin } = await import("@/lib/admin/confirm-booking");
    const db = await getDb();

    const [v] = await db.insert(vehicles).values({
      slug: "desk-confirm-fallback-car", plate: "DESK-FALLBK", name: "Desk Fallback Car", class: "Jeep", status: "active",
      seats: 5, transmission: "Automatic", doors: 5,
      priceDayCents: 6000, priceWeekCents: 36000, priceMonthCents: 120000,
    }).returning();
    const [c] = await db.insert(customers).values({ email: "desk-fallback@example.com", name: "Fallback Cust", phone: "" }).returning();
    const [b] = await db.insert(bookings).values({
      vehicleId: v!.id, customerId: c!.id,
      startAt: "2027-11-01T10:00:00-04:00", endAt: "2027-11-03T10:00:00-04:00",
      bufferEndAt: "2027-11-04T10:00:00-04:00", status: "pending",
      priceBreakdown: { subtotalCents: 12000, currency: "USD" }, paymentOption: "full",
      acceptedPolicyVersion: 0, acceptedAt: new Date(), idempotencyKey: "desk-confirm-fallback-1",
    }).returning();
    // Deliberately no createApprovalRequest(b.id): this booking has no open
    // request, so confirmBookingAdmin takes its plain-flip branch, not
    // applyDecision.

    sendAndLog.mockClear();
    sendToMany.mockClear();

    const confirmed = await confirmBookingAdmin(b!.id, "Fallback Admin");
    expect(confirmed.status).toBe("confirmed");

    expect(sendToMany).toHaveBeenCalledTimes(1);
    const [recipients, build] = sendToMany.mock.calls[0]!;
    expect(recipients).toEqual(["owner1@example.com", "owner2@example.com"]);
    const ownerEmail = build(recipients[1]!);
    expect(ownerEmail.type).toBe("admin_reservation_confirmed");
    expect(ownerEmail.html).toContain("Desk Fallback Car");
    expect(ownerEmail.html).toContain("USD 120.00");
  });
});
