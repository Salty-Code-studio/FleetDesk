import { describe, it, expect, beforeAll } from "vitest";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { vehicles, customers, bookings, payments } from "@/lib/db/schema";
import { createBookingCheckout } from "@/lib/payments/checkout";

let db: Awaited<ReturnType<typeof getDb>>;
let vehicleId = "", customerId = "";

const breakdown = {
  days: 7, vehicleCents: 34800, insuranceCents: 0, addOns: [], addOnsCents: 0,
  subtotalCents: 34800, depositCents: 25000, reservationFeeCents: 3000, currency: "USD",
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
      vehicleId, customerId, startDate: "2028-01-01", endDate: "2028-01-05", bufferEndDate: "2028-01-06",
      status: "confirmed", priceBreakdown: breakdown, paymentOption: "reservation_fee",
      acceptedPolicyVersion: 1, acceptedAt: new Date(), idempotencyKey: "co-1",
    }).returning();
    await expect(createBookingCheckout(b!.id, "http://localhost")).rejects.toThrow(/no longer awaiting payment/i);
  });

  it("refuses to start a second checkout once a payment has succeeded (double-charge guard)", async () => {
    const [b] = await db.insert(bookings).values({
      vehicleId, customerId, startDate: "2028-02-01", endDate: "2028-02-05", bufferEndDate: "2028-02-06",
      status: "pending", priceBreakdown: breakdown, paymentOption: "reservation_fee",
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
