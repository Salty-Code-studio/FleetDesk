import { describe, it, expect, beforeAll } from "vitest";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { vehicles, customers, bookings, settings as settingsTable } from "@/lib/db/schema";
import { isoDate } from "@/lib/validation/iso-date";
import { atAruba } from "@/lib/time/format";
import { translateDbError } from "@/lib/db/errors";
import { ManualBookingSchema } from "@/lib/admin/manual-booking";
import { MoveSchema } from "@/lib/admin/move-booking";
import { checkAvailability } from "@/lib/booking/availability";
import { expireStaleHolds } from "@/lib/payments/holds";
import { processStripeEvent } from "@/lib/payments/webhook";
import { payments } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";

let db: Awaited<ReturnType<typeof getDb>>;

beforeAll(async () => {
  db = await getDb();
  await runMigrations();
  await db.insert(settingsTable).values({ id: 1 }).onConflictDoNothing();
});

describe("calendar-date validation (findings #7/#8/#10)", () => {
  it("rejects impossible calendar dates that the regex alone passed", () => {
    for (const bad of ["2027-02-30", "2027-04-31", "2027-13-01", "2027-00-10", "2027-02-29"]) {
      expect(isoDate.safeParse(bad).success).toBe(false);
    }
  });
  it("accepts real dates", () => {
    for (const ok of ["2026-02-28", "2028-02-29", "2026-12-31"]) {
      expect(isoDate.safeParse(ok).success).toBe(true);
    }
  });
  it("ManualBookingSchema and MoveSchema reject impossible timestamps", () => {
    expect(ManualBookingSchema.safeParse({
      vehicleId: "00000000-0000-0000-0000-000000000000",
      startAt: "2026-04-15T09:00:00-04:00", endAt: "2026-04-31T09:00:00-04:00", customerName: "X",
    }).success).toBe(false);
    expect(MoveSchema.safeParse({ endAt: "2026-13-01T09:00:00-04:00" }).success).toBe(false);
  });
});

describe("translateDbError mappings (findings #6/#7/#8)", () => {
  it("maps datetime overflow 22008 to a clean bad_request", () => {
    expect(translateDbError({ code: "22008" })?.code).toBe("bad_request");
    expect(translateDbError({ code: "22007" })?.code).toBe("bad_request");
  });
  it("maps deadlock 40P01 and serialization 40001 to a retriable conflict", () => {
    expect(translateDbError({ code: "40P01" })?.code).toBe("conflict");
    expect(translateDbError({ cause: { code: "40001" } })?.code).toBe("conflict");
  });
});

describe("checkAvailability uses each booking's stored buffer (finding #9)", () => {
  it("does not retro-block a slot when the global buffer is raised after a booking", async () => {
    const [v] = await db.insert(vehicles).values({
      slug: "buf-raise", plate: "BR-1", class: "SUV", name: "Buf", seats: 5, transmission: "Automatic",
      doors: 5, priceDayCents: 1, priceWeekCents: 1, priceMonthCents: 1,
    }).returning();
    const [c] = await db.insert(customers).values({ email: "buf@test.com" }).returning();
    // booking made under a 24-hour buffer: stored bufferEndAt = end + 24h
    await db.insert(bookings).values({
      vehicleId: v!.id, customerId: c!.id, startAt: atAruba("2026-08-01", "09:00"), endAt: atAruba("2026-08-10", "09:00"), bufferEndAt: atAruba("2026-08-11", "09:00"),
      status: "confirmed", priceBreakdown: {}, paymentOption: "deposit",
      acceptedPolicyVersion: 1, acceptedAt: new Date(), idempotencyKey: "buf-raise-1",
    });
    // admin later raises the global buffer to 72 hours. A pickup on 08-11 (one clear
    // day after the stored buffer) must still be AVAILABLE — the old code wrongly
    // widened by the new buffer and blocked it.
    const res = await checkAvailability(v!.id, atAruba("2026-08-11", "09:00"), atAruba("2026-08-14", "09:00"), { turnaroundBufferHours: 72 });
    expect(res.available).toBe(true);
    // but 08-10 (inside the stored buffer) is still correctly blocked
    const res2 = await checkAvailability(v!.id, atAruba("2026-08-10", "09:00"), atAruba("2026-08-14", "09:00"), { turnaroundBufferHours: 72 });
    expect(res2.available).toBe(false);
  });
});

describe("abandoned checkout frees the car (finding #2)", () => {
  function expiredEvent(id: string, sessionId: string): Stripe.Event {
    return {
      id, type: "checkout.session.expired", object: "event", api_version: null,
      created: 0, livemode: false, pending_webhooks: 0, request: null,
      data: { object: { id: sessionId, object: "checkout.session" } as Stripe.Checkout.Session },
    } as Stripe.Event;
  }
  it("checkout.session.expired marks the pending payment failed so the hold can be reclaimed", async () => {
    const [v] = await db.insert(vehicles).values({
      slug: "exp-car", plate: "EX-1", class: "SUV", name: "Exp", seats: 5, transmission: "Automatic",
      doors: 5, priceDayCents: 1, priceWeekCents: 1, priceMonthCents: 1,
    }).returning();
    const [c] = await db.insert(customers).values({ email: "exp@test.com" }).returning();
    const old = new Date(Date.now() - 60 * 60_000);
    const [b] = await db.insert(bookings).values({
      vehicleId: v!.id, customerId: c!.id, startAt: atAruba("2029-01-01", "09:00"), endAt: atAruba("2029-01-05", "09:00"), bufferEndAt: atAruba("2029-01-06", "09:00"),
      status: "pending", priceBreakdown: {}, paymentOption: "deposit",
      acceptedPolicyVersion: 1, acceptedAt: new Date(), idempotencyKey: "exp-1", createdAt: old,
    }).returning();
    await db.insert(payments).values({
      bookingId: b!.id, stripeCheckoutSessionId: "cs_expired_1", type: "reservation_fee",
      amountCents: 3000, currency: "USD", status: "pending",
    });
    // before: a stale pending payment pins the booking — hold-expiry skips it
    expect(await expireStaleHolds(30)).toBe(0);
    // the expired webhook fails that payment...
    await processStripeEvent(expiredEvent("evt_exp_1", "cs_expired_1"));
    const [pay] = await db.select().from(payments).where(eq(payments.stripeCheckoutSessionId, "cs_expired_1"));
    expect(pay!.status).toBe("failed");
    // ...so the next hold-expiry run reclaims the slot
    expect(await expireStaleHolds(30)).toBeGreaterThanOrEqual(1);
    const [after] = await db.select().from(bookings).where(eq(bookings.id, b!.id));
    expect(after!.status).toBe("cancelled");
  });
});
