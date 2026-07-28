/**
 * Regression: notifyBookingCancelled must render the refund amount in the
 * PAYMENT's currency, not the global settings currency. An operator can
 * change settings.currency any time; the money that actually moved is fixed
 * to whatever currency the booking was paid in (mirrors notifyBookingConfirmed).
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { vehicles, settings, customers, bookings, payments } from "@/lib/db/schema";
import { atAruba } from "@/lib/time/format";
import type { OutboundEmail } from "@/lib/email/send";

// Capture what notifyBookingCancelled actually sends, without a real Resend
// call. sendAndLog/sendToMany run for real elsewhere; here we only need the
// rendered html that was about to go out.
const sendAndLog = vi.fn<(msg: OutboundEmail) => Promise<"skipped">>(async () => "skipped");
const sendToMany = vi.fn<(recipients: string[], build: (to: string) => OutboundEmail) => Promise<undefined>>(async () => undefined);
vi.mock("@/lib/email/send", () => ({
  sendAndLog: (msg: OutboundEmail) => sendAndLog(msg),
  sendToMany: (recipients: string[], build: (to: string) => OutboundEmail) => sendToMany(recipients, build),
}));

import { notifyBookingCancelled } from "@/lib/email/notifications";

let db: Awaited<ReturnType<typeof getDb>>;
let vehicleId = "", customerId = "";

const breakdown = {
  days: 7, vehicleCents: 34800, insuranceCents: 0, addOns: [], addOnsCents: 0,
  subtotalCents: 34800, depositCents: 4000, youngDriverCents: 0, depositPercent: 0, depositMinCents: 3000, currency: "USD",
};

beforeAll(async () => {
  db = await getDb();
  await runMigrations();
  // Global setting now differs from the currency this booking was actually
  // paid in -- simulates the operator changing it AFTER the booking was paid.
  await db.insert(settings).values({ id: 1, currency: "EUR" })
    .onConflictDoUpdate({ target: settings.id, set: { currency: "EUR" } });
  const [v] = await db.insert(vehicles).values({
    slug: "cancel-notif-car", plate: "PL-CANCEL-NOTIF", class: "SUV", name: "Cancel Notif Car", seats: 5,
    transmission: "Automatic", doors: 5, priceDayCents: 5800, priceWeekCents: 34800, priceMonthCents: 118000, depositCents: 4000,
  }).returning();
  const [c] = await db.insert(customers).values({ email: "cancel-notif@test.com" }).returning();
  vehicleId = v!.id; customerId = c!.id;
});

describe("notifyBookingCancelled currency label", () => {
  it("uses the payment's currency for the refund line, not the global settings currency", async () => {
    const [b] = await db.insert(bookings).values({
      vehicleId, customerId,
      startAt: atAruba("2027-01-08", "09:00"), endAt: atAruba("2027-01-15", "09:00"), bufferEndAt: atAruba("2027-01-16", "09:00"),
      status: "cancelled", priceBreakdown: breakdown, paymentOption: "deposit",
      acceptedPolicyVersion: 1, acceptedAt: new Date(), idempotencyKey: "cancel-notif-1",
      amountPaidCents: 0,
    }).returning();
    await db.insert(payments).values({
      bookingId: b!.id,
      stripeCheckoutSessionId: "cs_cancel_notif_1", stripePaymentIntentId: "pi_cancel_notif_1",
      type: "rental_deposit", method: "stripe", amountCents: 4000, currency: "USD", status: "succeeded",
    });

    sendAndLog.mockClear();
    await notifyBookingCancelled(b!.id, { refunded: true, refundCents: 4000 });

    const customerCall = sendAndLog.mock.calls.find((c) => c[0].type === "booking_cancelled");
    expect(customerCall).toBeDefined();
    const html = customerCall![0].html;
    expect(html).toContain("USD 40.00"); // the payment's own currency
    expect(html).not.toContain("EUR 40.00"); // NOT the (now-different) global settings currency
  });

  it("falls back to the booking's price-breakdown currency when no payment row exists", async () => {
    const [b] = await db.insert(bookings).values({
      vehicleId, customerId,
      startAt: atAruba("2027-02-08", "09:00"), endAt: atAruba("2027-02-15", "09:00"), bufferEndAt: atAruba("2027-02-16", "09:00"),
      status: "cancelled", priceBreakdown: breakdown, paymentOption: "deposit",
      acceptedPolicyVersion: 1, acceptedAt: new Date(), idempotencyKey: "cancel-notif-2",
      amountPaidCents: 0,
    }).returning();

    sendAndLog.mockClear();
    await notifyBookingCancelled(b!.id, { refunded: true, refundCents: 4000 });

    const customerCall = sendAndLog.mock.calls.find((c) => c[0].type === "booking_cancelled");
    expect(customerCall).toBeDefined();
    const html = customerCall![0].html;
    expect(html).toContain("USD 40.00"); // the booking's price-breakdown currency
    expect(html).not.toContain("EUR 40.00"); // still not the global settings currency
  });
});
