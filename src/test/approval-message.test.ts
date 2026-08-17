import { describe, it, expect, beforeAll } from "vitest";
import { runMigrations } from "@/lib/db/migrate";
import { getDb } from "@/lib/db/client";
import { bookings, customers, vehicles } from "@/lib/db/schema";
import { buildApprovalMessage } from "@/lib/approval/message";

let targetBookingId = "";

beforeAll(async () => {
  await runMigrations();
  const db = await getDb();
  const [a] = await db.insert(vehicles).values({
    slug: "msg-a", name: "Yaris A", class: "Economy", status: "active",
    plate: "MSG-A-001", seats: 5, transmission: "Automatic", doors: 5,
    priceDayCents: 5000, priceWeekCents: 30000, priceMonthCents: 100000,
  }).returning();
  const [b] = await db.insert(vehicles).values({
    slug: "msg-b", name: "Yaris B", class: "Economy", status: "active",
    plate: "MSG-B-001", seats: 5, transmission: "Automatic", doors: 5,
    priceDayCents: 5000, priceWeekCents: 30000, priceMonthCents: 100000,
  }).returning();
  await db.insert(customers).values({ email: "msg@example.com", name: "Sarah Jenkins", phone: "+599 785 1111" });
  const [c] = await db.select().from(customers);
  // Vehicle B is taken over the same dates (confirmed) -> only A is free.
  await db.insert(bookings).values({
    vehicleId: b!.id, customerId: c!.id,
    startAt: "2027-05-01T10:00:00-04:00", endAt: "2027-05-06T10:00:00-04:00",
    bufferEndAt: "2027-05-07T10:00:00-04:00", status: "confirmed",
    priceBreakdown: { subtotalCents: 25000, currency: "USD" }, paymentOption: "full",
    acceptedPolicyVersion: 0, acceptedAt: new Date(), idempotencyKey: "msg-key-b",
  });
  const [t] = await db.insert(bookings).values({
    vehicleId: a!.id, customerId: c!.id,
    startAt: "2027-05-02T10:00:00-04:00", endAt: "2027-05-04T10:00:00-04:00",
    bufferEndAt: "2027-05-05T10:00:00-04:00", status: "pending",
    priceBreakdown: { subtotalCents: 10000, currency: "USD" }, paymentOption: "full",
    acceptedPolicyVersion: 0, acceptedAt: new Date(), idempotencyKey: "msg-key-t",
  }).returning();
  targetBookingId = t!.id;
});

describe("buildApprovalMessage", () => {
  it("summarizes the booking and counts same-class availability", async () => {
    const msg = await buildApprovalMessage(targetBookingId);
    expect(msg).not.toBeNull();
    expect(msg!.vehicleName).toBe("Yaris A");
    expect(msg!.customerName).toBe("Sarah Jenkins");
    // B conflicts, A carries only the target booking itself -> 1 of 2 free.
    expect(msg!.fleetLine).toBe("Fleet check: 1 of 2 Economy free on those dates");
    expect(msg!.text).toContain("New booking");
    expect(msg!.text).toContain("Yaris A");
    expect(msg!.text).toContain("pay at pickup");
    expect(msg!.text).toContain(msg!.fleetLine);
    expect(msg!.text).not.toMatch(/—|--/); // Mo's copy rule
  });
  it("returns null for an unknown booking", async () => {
    expect(await buildApprovalMessage("00000000-0000-4000-8000-000000000000")).toBeNull();
  });
});
