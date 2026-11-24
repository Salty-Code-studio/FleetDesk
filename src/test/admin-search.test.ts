import { describe, it, expect, beforeAll } from "vitest";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { vehicles, settings, customers, bookings } from "@/lib/db/schema";
import { searchDesk, searchDates, SearchQuerySchema } from "@/lib/admin/search";

let db: Awaited<ReturnType<typeof getDb>>;
const NOW = new Date("2030-06-15T12:00:00Z");
let idem = 0;

async function mkVehicle(slug: string, plate: string, name: string) {
  const [v] = await db.insert(vehicles).values({
    slug, plate, class: "Scooter", name, seats: 2, transmission: "Automatic",
    doors: 0, priceDayCents: 2250, priceWeekCents: 14000, priceMonthCents: 30000, depositCents: 10000,
  }).returning();
  return v!.id;
}

async function mkBooking(vehicleId: string, customerId: string, start: string, end: string, status: "pending" | "confirmed" | "picked_up" | "completed" | "cancelled") {
  const [b] = await db.insert(bookings).values({
    vehicleId, customerId, startAt: start, endAt: end, bufferEndAt: end, status,
    priceBreakdown: {}, paymentOption: "full", acceptedPolicyVersion: 1, acceptedAt: new Date(),
    idempotencyKey: `search-test-${idem++}`,
  }).returning();
  return b!.id;
}

let marjaPast = "", marjaNow = "", marjaNext = "", marjaCancelled = "";

beforeAll(async () => {
  db = await getDb();
  await runMigrations();
  await db.insert(settings).values({ id: 1 }).onConflictDoNothing();
  const v1 = await mkVehicle("srch-myst-1", "MF- 5665", "Srch Myst 50cc");
  const v2 = await mkVehicle("srch-myst-2", "MF4910X", "Srch Myst 50cc");
  const [marja] = await db.insert(customers).values({ email: "marja.srch@example.com", name: "Marja Zoekmans", phone: "+599 717-1234" }).returning();
  const [kees] = await db.insert(customers).values({ email: "kees.srch@example.com", name: "Kees Vinder", phone: "+31 6 9988 7766" }).returning();
  marjaPast = await mkBooking(v1, marja!.id, "2030-05-01T13:00:00Z", "2030-05-03T13:00:00Z", "completed");
  marjaNow = await mkBooking(v1, marja!.id, "2030-06-14T13:00:00Z", "2030-06-17T13:00:00Z", "picked_up");
  marjaNext = await mkBooking(v2, marja!.id, "2030-07-01T13:00:00Z", "2030-07-04T13:00:00Z", "confirmed");
  marjaCancelled = await mkBooking(v2, marja!.id, "2030-08-01T13:00:00Z", "2030-08-04T13:00:00Z", "cancelled");
  await mkBooking(v2, kees!.id, "2030-06-10T13:00:00Z", "2030-06-12T13:00:00Z", "completed");
});

describe("desk search", () => {
  it("finds a customer by part of the name, case-insensitive", async () => {
    const r = await searchDesk("zoekm", NOW);
    expect(r.customers.map((c) => c.name)).toEqual(["Marja Zoekmans"]);
    expect(r.customers[0]!.rentals).toBe(4);
  });

  it("orders rentals: with the customer, upcoming, past, cancelled last", async () => {
    const r = await searchDesk("marja.srch@", NOW);
    expect(r.customers[0]!.bookings.map((b) => b.id)).toEqual([marjaNow, marjaNext, marjaPast, marjaCancelled]);
    expect(r.customers[0]!.bookings[0]!.statusLabel).toBe("With customer");
  });

  it("matches phone by digits, ignoring spaces, dashes and plus", async () => {
    const r = await searchDesk("717 1234", NOW);
    expect(r.customers.map((c) => c.name)).toEqual(["Marja Zoekmans"]);
  });

  it("matches a plate with or without the dash and space", async () => {
    const r = await searchDesk("mf5665", NOW);
    expect(r.customers.map((c) => c.name)).toEqual(["Marja Zoekmans"]);
    expect(r.customers[0]!.bookings.every((b) => b.plate === "MF- 5665")).toBe(true);
  });

  it("groups several customers when a plate was rented by both", async () => {
    const r = await searchDesk("MF4910X", NOW);
    expect(r.customers.map((c) => c.name).sort()).toEqual(["Kees Vinder", "Marja Zoekmans"]);
  });

  it("finds a booking by the first characters of its id", async () => {
    const r = await searchDesk(marjaNext.slice(0, 8), NOW);
    expect(r.customers[0]!.bookings.map((b) => b.id)).toContain(marjaNext);
  });

  it("treats % and _ as plain text", async () => {
    expect((await searchDesk("%%", NOW)).customers).toEqual([]);
    expect((await searchDesk("__", NOW)).customers).toEqual([]);
  });

  it("returns nothing for a miss", async () => {
    expect((await searchDesk("nobody-here-xyz", NOW)).customers).toEqual([]);
  });

  it("needs at least two characters", () => {
    expect(SearchQuerySchema.safeParse({ q: "a" }).success).toBe(false);
    expect(SearchQuerySchema.safeParse({ q: " ab " }).success).toBe(true);
  });

  it("formats dates short, with the year only when it is not this year", () => {
    expect(searchDates("2030-06-14T13:00:00Z", "2030-06-17T13:00:00Z", NOW)).toBe("14 Jun to 17 Jun");
    expect(searchDates("2029-12-30T13:00:00Z", "2030-01-02T13:00:00Z", NOW)).toBe("30 Dec 2029 to 2 Jan");
  });
});
