import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { vehicles, customers, bookings, payments } from "@/lib/db/schema";
import { expireStaleHolds } from "@/lib/payments/holds";
import { atAruba } from "@/lib/time/format";

let db: Awaited<ReturnType<typeof getDb>>;
let vehicleId = "", customerId = "";

const bd = { subtotalCents: 1 };

let dateCursor = 1;
async function mkBooking(key: string, createdAt: Date, status: "pending" | "confirmed", paid = false) {
  // distinct non-overlapping dates per booking (same vehicle, buffered constraint)
  const month = String(dateCursor++).padStart(2, "0");
  const [b] = await db.insert(bookings).values({
    vehicleId, customerId,
    startAt: atAruba(`2027-${month}-01`, "09:00"), endAt: atAruba(`2027-${month}-05`, "09:00"), bufferEndAt: atAruba(`2027-${month}-06`, "09:00"),
    status, priceBreakdown: bd, paymentOption: "reservation_fee", acceptedPolicyVersion: 1,
    acceptedAt: new Date(), idempotencyKey: key, createdAt,
  }).returning();
  if (paid) {
    await db.insert(payments).values({ bookingId: b!.id, type: "reservation_fee", amountCents: 3000, currency: "USD", status: "succeeded" });
  }
  return b!;
}

beforeAll(async () => {
  db = await getDb();
  await runMigrations();
  const [v] = await db.insert(vehicles).values({
    slug: "hold-car", plate: "PL-hold-car", class: "SUV", name: "Hold Car", seats: 5, transmission: "Automatic",
    doors: 5, priceDayCents: 1, priceWeekCents: 1, priceMonthCents: 1,
  }).returning();
  const [c] = await db.insert(customers).values({ email: "hold@test.com" }).returning();
  vehicleId = v!.id; customerId = c!.id;
});

describe("expireStaleHolds", () => {
  it("cancels an old unpaid pending hold", async () => {
    const old = new Date(Date.now() - 60 * 60_000); // 60 min ago
    const b = await mkBooking("hold-old", old, "pending");
    const n = await expireStaleHolds(30);
    expect(n).toBeGreaterThanOrEqual(1);
    const [after] = await db.select().from(bookings).where(eq(bookings.id, b.id));
    expect(after!.status).toBe("cancelled");
  });

  it("leaves a recent pending hold alone", async () => {
    const recent = new Date(Date.now() - 5 * 60_000); // 5 min ago
    const b = await mkBooking("hold-recent", recent, "pending");
    await expireStaleHolds(30);
    const [after] = await db.select().from(bookings).where(eq(bookings.id, b.id));
    expect(after!.status).toBe("pending");
  });

  it("leaves an old but PAID pending hold alone", async () => {
    const old = new Date(Date.now() - 60 * 60_000);
    const b = await mkBooking("hold-paid", old, "pending", true);
    await expireStaleHolds(30);
    const [after] = await db.select().from(bookings).where(eq(bookings.id, b.id));
    expect(after!.status).toBe("pending");
  });

  it("leaves an old hold that is mid-checkout (a PENDING payment) alone", async () => {
    const old = new Date(Date.now() - 60 * 60_000);
    const b = await mkBooking("hold-paying", old, "pending");
    await db.insert(payments).values({ bookingId: b.id, type: "reservation_fee", amountCents: 3000, currency: "USD", status: "pending" });
    await expireStaleHolds(30);
    const [after] = await db.select().from(bookings).where(eq(bookings.id, b.id));
    expect(after!.status).toBe("pending"); // never strand a customer mid-payment
  });

  it("never touches a confirmed booking", async () => {
    const old = new Date(Date.now() - 60 * 60_000);
    const b = await mkBooking("hold-confirmed", old, "confirmed");
    await expireStaleHolds(30);
    const [after] = await db.select().from(bookings).where(eq(bookings.id, b.id));
    expect(after!.status).toBe("confirmed");
  });
});
