import { describe, it, expect, beforeAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { vehicles, customers, bookings } from "@/lib/db/schema";

// requireAdmin reads cookies via next/headers, which throws outside a live
// Next request scope; an EMPTY jar stands in (same stand-in as
// desk-mode-ui-config.test.ts) so the route's admin guard sees "no session"
// instead of crashing, once a request gets past body validation.
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

let db: Awaited<ReturnType<typeof getDb>>;
let vehicleId = "", customerId = "";
let seq = 1;

async function mkBooking(status: "confirmed" | "picked_up" | "cancelled") {
  const m = String(seq++).padStart(2, "0");
  const [b] = await db.insert(bookings).values({
    vehicleId, customerId,
    startAt: `2027-${m}-01T13:00:00Z`,
    endAt: `2027-${m}-25T13:00:00Z`,
    bufferEndAt: `2027-${m}-26T13:00:00Z`,
    status,
    priceBreakdown: { subtotalCents: 120000, currency: "USD" },
    paymentOption: "full", acceptedPolicyVersion: 1, acceptedAt: new Date(),
    idempotencyKey: `paiduntil-${m}`,
  }).returning();
  return b!;
}

beforeAll(async () => {
  db = await getDb();
  await runMigrations();
  const [v] = await db.insert(vehicles).values({
    slug: "pu-car", plate: "PL-pu", class: "SUV", name: "Paid Until Car", seats: 5,
    transmission: "Automatic", doors: 5, priceDayCents: 10000, priceWeekCents: 60000,
    priceMonthCents: 200000,
  }).returning();
  const [c] = await db.insert(customers).values({ email: "paiduntil@test.com" }).returning();
  vehicleId = v!.id; customerId = c!.id;
});

describe("paid_until column", () => {
  it("defaults to null and round-trips a YYYY-MM-DD string", async () => {
    const b = await mkBooking("picked_up");
    expect(b.paidUntil).toBeNull();

    await db.update(bookings).set({ paidUntil: "2027-04-30" }).where(eq(bookings.id, b.id));
    const [after] = await db.select().from(bookings).where(eq(bookings.id, b.id));
    expect(after!.paidUntil).toBe("2027-04-30");
  });

  it("clears back to null", async () => {
    const b = await mkBooking("picked_up");
    await db.update(bookings).set({ paidUntil: "2027-05-31" }).where(eq(bookings.id, b.id));
    await db.update(bookings).set({ paidUntil: null }).where(eq(bookings.id, b.id));
    const [after] = await db.select().from(bookings).where(eq(bookings.id, b.id));
    expect(after!.paidUntil).toBeNull();
  });

  it("leaves the money ledger untouched", async () => {
    const b = await mkBooking("picked_up");
    await db.update(bookings).set({ paidUntil: "2027-06-30" }).where(eq(bookings.id, b.id));
    const [after] = await db.select().from(bookings).where(eq(bookings.id, b.id));
    expect(after!.amountPaidCents).toBe(0);
  });
});

describe("POST /api/admin/bookings/:id/paid-until — malformed-date rejection", () => {
  function post(id: string, paidUntil: string | null) {
    return import("@/app/api/admin/bookings/[id]/paid-until/route").then(({ POST }) =>
      POST(
        new Request(`http://localhost:3000/api/admin/bookings/${id}/paid-until`, {
          method: "POST",
          headers: { "content-type": "application/json", "user-agent": "t" },
          body: JSON.stringify({ paidUntil }),
        }),
        { params: Promise.resolve({ id }) },
      ),
    );
  }

  it("rejects a calendrically invalid date (2027-02-30) at body validation (422), never reaching auth or the database", async () => {
    const b = await mkBooking("picked_up");
    const res = await post(b.id, "2027-02-30");
    // Body validation (parseJsonBody) runs BEFORE mutate()'s requireAdmin call.
    // With only the format-only regex, "2027-02-30" matches YYYY-MM-DD and
    // sails through to mutate() -> requireAdmin(), which 401s on this
    // session-less request â€” masking the real bug: without a semantic check
    // this same date would clear validation on an AUTHENTICATED request too
    // and reach Postgres, which throws 22008 there. A strict 422 here proves
    // the schema itself caught it, before auth, before the database.
    expect(res.status).toBe(422);
    const [after] = await db.select().from(bookings).where(eq(bookings.id, b.id));
    expect(after!.paidUntil).toBeNull(); // untouched
  });

  it("lets a real, calendrically valid date clear validation (reaches the auth guard, not a validation 4xx)", async () => {
    const b = await mkBooking("picked_up");
    const res = await post(b.id, "2027-02-28");
    // No session on the request: a real date must clear body validation and
    // reach requireAdmin's 401, never the validation-error status.
    expect(res.status).toBe(401);
  });
});
