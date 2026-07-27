import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { vehicles, customers, bookings } from "@/lib/db/schema";
import { listCustomerBookings, cancelOwnBooking } from "@/lib/booking/customer-bookings";
import { atAruba } from "@/lib/time/format";
import { expectReject } from "./util";

let db: Awaited<ReturnType<typeof getDb>>;
let vehicleId = "", aliceId = "", bobId = "";

const bd = { subtotalCents: 1 };
let cursor = 1;
async function mk(customerId: string, status: "pending" | "confirmed" | "completed" = "pending") {
  const m = String(cursor++).padStart(2, "0");
  const [b] = await db.insert(bookings).values({
    vehicleId, customerId,
    startAt: atAruba(`2027-${m}-01`, "09:00"), endAt: atAruba(`2027-${m}-05`, "09:00"), bufferEndAt: atAruba(`2027-${m}-06`, "09:00"),
    status, priceBreakdown: bd, paymentOption: "reservation_fee", acceptedPolicyVersion: 1,
    acceptedAt: new Date(), idempotencyKey: `cb-${m}`,
  }).returning();
  return b!;
}

beforeAll(async () => {
  db = await getDb();
  await runMigrations();
  const [v] = await db.insert(vehicles).values({
    slug: "cb-car", plate: "PL-cb-car", class: "SUV", name: "CB Car", seats: 5, transmission: "Automatic",
    doors: 5, priceDayCents: 1, priceWeekCents: 1, priceMonthCents: 1,
  }).returning();
  const [a] = await db.insert(customers).values({ email: "alice@test.com" }).returning();
  const [b] = await db.insert(customers).values({ email: "bob@test.com" }).returning();
  vehicleId = v!.id; aliceId = a!.id; bobId = b!.id;
});

describe("customer bookings", () => {
  it("lists only the customer's own bookings", async () => {
    await mk(aliceId);
    await mk(aliceId);
    await mk(bobId);
    const aliceBookings = await listCustomerBookings(aliceId);
    expect(aliceBookings.length).toBe(2);
    expect(aliceBookings.every((b) => b.vehicleName === "CB Car")).toBe(true);
  });

  it("cancels the customer's own booking and frees the slot", async () => {
    const b = await mk(aliceId, "confirmed");
    const res = await cancelOwnBooking(aliceId, b.id);
    expect(res.id).toBe(b.id);
    const [after] = await db.select().from(bookings).where(eq(bookings.id, b.id));
    expect(after!.status).toBe("cancelled");
  });

  it("refuses to cancel someone else's booking (404, no enumeration)", async () => {
    const bobBooking = await mk(bobId, "confirmed");
    await expectReject(cancelOwnBooking(aliceId, bobBooking.id), /not found/i);
    // bob's booking is untouched
    const [after] = await db.select().from(bookings).where(eq(bookings.id, bobBooking.id));
    expect(after!.status).toBe("confirmed");
  });

  it("refuses to cancel a completed booking", async () => {
    const done = await mk(aliceId, "completed");
    await expectReject(cancelOwnBooking(aliceId, done.id), /no longer be cancelled/i);
  });
});
