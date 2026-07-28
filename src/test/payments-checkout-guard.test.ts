import { describe, it, expect, vi, beforeAll } from "vitest";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { vehicles, customers, bookings, payments } from "@/lib/db/schema";
import { createBookingCheckout, createExtensionCheckout } from "@/lib/payments/checkout";
import { atAruba } from "@/lib/time/format";

// Both existing guard tests below throw BEFORE any Stripe network call, but the
// house-style line-item-name regression test needs to actually reach
// stripe.checkout.sessions.create and inspect what it was called with, so the
// whole file stubs Stripe like the other payment tests do (see
// extend-booking.test.ts). A fresh session id per call: stripeCheckoutSessionId
// is unique in the schema.
let stripeSessionCursor = 0;
let lastCreateParams: unknown;
const stripeSessionCreate = vi.fn(async (params: unknown) => {
  stripeSessionCursor += 1;
  lastCreateParams = params;
  return { id: `cs_co_test_${stripeSessionCursor}`, url: "https://checkout.stripe.test/co" };
});
const stripeSessionExpire = vi.fn(async () => ({}));
vi.mock("@/lib/payments/stripe-client", () => ({
  getStripe: () => ({ checkout: { sessions: { create: stripeSessionCreate, expire: stripeSessionExpire } } }),
}));

let db: Awaited<ReturnType<typeof getDb>>;
let vehicleId = "", customerId = "";

const breakdown = {
  days: 7, vehicleCents: 34800, insuranceCents: 0, addOns: [], addOnsCents: 0,
  subtotalCents: 34800, depositCents: 25000, youngDriverCents: 0, depositPercent: 0, depositMinCents: 3000, currency: "USD",
};

beforeAll(async () => {
  db = await getDb();
  await runMigrations();
  const [v] = await db.insert(vehicles).values({
    slug: "co-car", plate: "PL-co-car", class: "SUV", name: "CO Car", seats: 5, transmission: "Automatic",
    doors: 5, priceDayCents: 5800, priceWeekCents: 34800, priceMonthCents: 118000, depositCents: 25000,
  }).returning();
  const [c] = await db.insert(customers).values({ email: "co@test.com" }).returning();
  vehicleId = v!.id; customerId = c!.id;
});

describe("createBookingCheckout guards", () => {
  it("refuses a non-pending booking", async () => {
    const [b] = await db.insert(bookings).values({
      vehicleId, customerId,
      startAt: atAruba("2028-01-01", "09:00"), endAt: atAruba("2028-01-05", "09:00"), bufferEndAt: atAruba("2028-01-06", "09:00"),
      status: "confirmed", priceBreakdown: breakdown, paymentOption: "deposit",
      acceptedPolicyVersion: 1, acceptedAt: new Date(), idempotencyKey: "co-1",
    }).returning();
    await expect(createBookingCheckout(b!.id, "http://localhost")).rejects.toThrow(/no longer awaiting payment/i);
  });

  it("refuses to start a second checkout once a payment has succeeded (double-charge guard)", async () => {
    const [b] = await db.insert(bookings).values({
      vehicleId, customerId,
      startAt: atAruba("2028-02-01", "09:00"), endAt: atAruba("2028-02-05", "09:00"), bufferEndAt: atAruba("2028-02-06", "09:00"),
      status: "pending", priceBreakdown: breakdown, paymentOption: "deposit",
      acceptedPolicyVersion: 1, acceptedAt: new Date(), idempotencyKey: "co-2",
    }).returning();
    await db.insert(payments).values({
      bookingId: b!.id, stripeCheckoutSessionId: "cs_already_paid", type: "reservation_fee",
      amountCents: 3000, currency: "USD", status: "succeeded",
    });
    // throws BEFORE any Stripe network call
    await expect(createBookingCheckout(b!.id, "http://localhost")).rejects.toThrow(/already paid/i);
  });
});

describe("Stripe line-item names (dash-free house style)", () => {
  it("createBookingCheckout never puts an em-dash in the line-item name shown on the Stripe checkout page", async () => {
    const [b] = await db.insert(bookings).values({
      vehicleId, customerId,
      startAt: atAruba("2028-03-01", "09:00"), endAt: atAruba("2028-03-05", "09:00"), bufferEndAt: atAruba("2028-03-06", "09:00"),
      status: "pending", priceBreakdown: breakdown, paymentOption: "deposit",
      acceptedPolicyVersion: 1, acceptedAt: new Date(), idempotencyKey: "co-3",
    }).returning();

    await createBookingCheckout(b!.id, "http://localhost");

    const call = lastCreateParams as {
      line_items: Array<{ price_data: { product_data: { name: string } } }>;
    };
    const name = call.line_items[0]!.price_data.product_data.name;
    expect(name).not.toContain("—"); // em-dash
    expect(name).toContain("CO Car");
  });

  it("createExtensionCheckout never puts an em-dash in the line-item name shown on the Stripe checkout page", async () => {
    const [b] = await db.insert(bookings).values({
      vehicleId, customerId,
      startAt: atAruba("2028-04-01", "09:00"), endAt: atAruba("2028-04-05", "09:00"), bufferEndAt: atAruba("2028-04-06", "09:00"),
      status: "confirmed", priceBreakdown: breakdown, paymentOption: "deposit",
      acceptedPolicyVersion: 1, acceptedAt: new Date(), idempotencyKey: "co-4",
    }).returning();

    await createExtensionCheckout(b!, 5000);

    const call = lastCreateParams as {
      line_items: Array<{ price_data: { product_data: { name: string } } }>;
    };
    const name = call.line_items[0]!.price_data.product_data.name;
    expect(name).not.toContain("—"); // em-dash
    expect(name).toContain("CO Car");
  });
});
