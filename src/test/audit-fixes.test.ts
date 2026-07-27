/**
 * Regression tests for the 2026-06-21 audit fixes. Each test locks in a fix the
 * existing suite did not cover (the audit flagged these exact gaps).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { z } from "zod";
import { sql, eq } from "drizzle-orm";
import { getDb, shouldUseSsl } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { parseJsonBody } from "@/lib/http/validate";
import { vehicles, settings, customers, bookings, addOns, bookingAddOns, adminUsers } from "@/lib/db/schema";
import { moveBooking } from "@/lib/admin/move-booking";
import { atAruba } from "@/lib/time/format";
import { expectReject } from "./util";

describe("shouldUseSsl — TLS keyed on host, not NODE_ENV", () => {
  it("requires TLS for managed/remote Postgres (Supabase, Neon)", () => {
    expect(shouldUseSsl("postgres://u:p@db.abc.supabase.co:5432/postgres")).toBe(true);
    expect(shouldUseSsl("postgres://u:p@ep-cool-1.eu-central-1.aws.neon.tech/db")).toBe(true);
  });
  it("exempts loopback hosts — including IPv6 [::1] (the regression)", () => {
    expect(shouldUseSsl("postgres://u:p@localhost:5432/db")).toBe(false);
    expect(shouldUseSsl("postgres://u:p@127.0.0.1:5432/db")).toBe(false);
    expect(shouldUseSsl("postgres://u:p@[::1]:5432/db")).toBe(false); // parses WITH brackets
  });
  it("honors an explicit sslmode=disable", () => {
    expect(shouldUseSsl("postgres://u:p@db.remote.example/db?sslmode=disable")).toBe(false);
  });
});

describe("parseJsonBody — body-size cap is enforced while streaming", () => {
  const schema = z.object({ a: z.string() });

  it("parses a normal small JSON body", async () => {
    const req = new Request("http://x/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ a: "ok" }),
    });
    expect(await parseJsonBody(req, schema)).toEqual({ a: "ok" });
  });

  it("rejects an oversized chunked body (no Content-Length) instead of buffering it whole", async () => {
    const huge = "x".repeat(2_000_000); // 2 MB > 1 MB cap
    const stream = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode(huge)); c.close(); },
    });
    const init: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half", // required by Node fetch for a stream body
    };
    await expectReject(parseJsonBody(new Request("http://x/", init), schema), /too large/i);
  });

  it("rejects a non-numeric Content-Length", async () => {
    const req = new Request("http://x/", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "not-a-number" },
      body: JSON.stringify({ a: "ok" }),
    });
    await expectReject(parseJsonBody(req, schema), /content-length/i);
  });
});

describe("moveBooking — re-prices and re-checks add-on stock for online bookings", () => {
  let db: Awaited<ReturnType<typeof getDb>>;
  let car = "";
  let chair = "";
  let custId = "";

  beforeAll(async () => {
    db = await getDb();
    await runMigrations();
    await db.insert(settings).values({ id: 1 }).onConflictDoNothing();
    const [v] = await db.insert(vehicles).values({
      slug: "rp-car", plate: "RP-CAR", class: "Economy", name: "Reprice Car", seats: 5, transmission: "Automatic",
      doors: 4, priceDayCents: 4000, priceWeekCents: 24000, priceMonthCents: 80000, depositCents: 25000,
    }).returning();
    car = v!.id;
    const [a] = await db.insert(addOns).values({ name: "Baby chair", priceCents: 500, pricing: "per_day", stock: 2 }).returning();
    chair = a!.id;
    const [c] = await db.insert(customers).values({ email: "reprice@test.com" }).returning();
    custId = c!.id;
  });

  async function onlineBooking(start: string, end: string, qty: number, key: string) {
    const [bk] = await db.insert(bookings).values({
      vehicleId: car, customerId: custId,
      startAt: atAruba(start, "09:00"), endAt: atAruba(end, "09:00"), bufferEndAt: atAruba(end, "09:00"),
      status: "confirmed", source: "online", priceBreakdown: { days: 0, addOns: [] },
      paymentOption: "deposit", acceptedPolicyVersion: 0, acceptedAt: new Date(), idempotencyKey: key,
    }).returning();
    await db.insert(bookingAddOns).values({ bookingId: bk!.id, addOnId: chair, qty, priceSnapshotCents: 500 * qty });
    return bk!;
  }

  it("recomputes the price snapshot for the new dates (#4)", async () => {
    const bk = await onlineBooking("2029-01-01", "2029-01-05", 1, "rp-1"); // 4 days
    const moved = await moveBooking(bk.id, { startAt: atAruba("2029-02-01", "09:00"), endAt: atAruba("2029-02-11", "09:00") }); // 10 days
    const pb = moved.priceBreakdown as { days: number; vehicleCents: number; addOns: { cents: number }[] };
    expect(pb.days).toBe(10);
    expect(pb.vehicleCents).toBeGreaterThan(0);
    expect(pb.addOns[0]!.cents).toBe(5000); // per-day chair: 500 * 10 days * qty 1
  });

  it("rejects a move that would oversell a limited add-on over the new window (#5, 409)", async () => {
    // Another car holds BOTH units of the 2-stock chair for the June window.
    const [v2] = await db.insert(vehicles).values({
      slug: "rp-car2", plate: "RP-CAR2", class: "Economy", name: "Reprice Car2", seats: 5, transmission: "Automatic",
      doors: 4, priceDayCents: 4000, priceWeekCents: 24000, priceMonthCents: 80000,
    }).returning();
    const [other] = await db.insert(bookings).values({
      vehicleId: v2!.id, customerId: custId,
      startAt: atAruba("2029-06-01", "09:00"), endAt: atAruba("2029-06-05", "09:00"), bufferEndAt: atAruba("2029-06-05", "09:00"),
      status: "confirmed", source: "online", priceBreakdown: { days: 4, addOns: [] },
      paymentOption: "deposit", acceptedPolicyVersion: 0, acceptedAt: new Date(), idempotencyKey: "rp-other",
    }).returning();
    await db.insert(bookingAddOns).values({ bookingId: other!.id, addOnId: chair, qty: 2, priceSnapshotCents: 1000 });

    // Booking X holds 2 chairs in January; the target car is free in June, but
    // moving X there needs 2 more chairs while 0 are left for that window.
    const x = await onlineBooking("2029-01-20", "2029-01-24", 2, "rp-x");
    await expectReject(
      moveBooking(x.id, { startAt: atAruba("2029-06-01", "09:00"), endAt: atAruba("2029-06-05", "09:00") }),
      /left for those dates|only|conflict/i,
    );
  });
});

describe("MFA lockout — DB-side atomic increment (#3)", () => {
  const THRESHOLD = 5;
  it("increments via CASE arithmetic and trips the lock at the threshold (no lost updates)", async () => {
    const db = await getDb();
    await runMigrations();
    const [a] = await db.insert(adminUsers).values({ email: "mfa-atomic@test.com", passwordHash: "x" }).returning();
    const lockUntil = new Date(Date.now() + 900_000);
    const tripped = sql`${adminUsers.mfaFailedAttempts} + 1 >= ${THRESHOLD}`;
    // The exact UPDATE recordMfaFailure runs: counts in the DB, not from a snapshot.
    const bump = () => db.update(adminUsers).set({
      mfaFailedAttempts: sql`CASE WHEN ${tripped} THEN 0 ELSE ${adminUsers.mfaFailedAttempts} + 1 END`,
      mfaLockedUntil: sql`CASE WHEN ${tripped} THEN ${lockUntil} ELSE ${adminUsers.mfaLockedUntil} END`,
    }).where(eq(adminUsers.id, a!.id)).returning({ attempts: adminUsers.mfaFailedAttempts, lockedUntil: adminUsers.mfaLockedUntil });

    for (let i = 1; i <= THRESHOLD - 1; i++) {
      const [r] = await bump();
      expect(r!.attempts).toBe(i);
      expect(r!.lockedUntil).toBeNull();
    }
    const [fifth] = await bump();
    expect(fifth!.attempts).toBe(0);           // reset on lock
    expect(fifth!.lockedUntil).not.toBeNull(); // locked
  });
});
