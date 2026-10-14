import { describe, it, expect, beforeAll } from "vitest";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { vehicles, customers, bookings } from "@/lib/db/schema";
import { getToday } from "@/lib/admin/today-loader";
import { atAruba } from "@/lib/time/format";

let db: Awaited<ReturnType<typeof getDb>>;
let customerId = "";
let n = 0, v = 0;

const day = "2028-03-10";
const now = atAruba(day, "08:00");
const at = (d: string, t: string) => atAruba(d, t);

// One vehicle per booking: bookings_no_overlap forbids overlapping windows on a
// vehicle. The first booking made gets plate TDY-001.
async function mkVehicle() {
  const i = ++v;
  const [row] = await db.insert(vehicles).values({
    slug: `today-car-${i}`, plate: `TDY-${String(i).padStart(3, "0")}`, class: "Economy", name: "Economy Hatchback",
    seats: 5, transmission: "automatic", doors: 4,
    priceDayCents: 3500, priceWeekCents: 21000, priceMonthCents: 70000,
  }).returning();
  return row!.id;
}

async function mk(status: "pending" | "confirmed" | "picked_up" | "completed" | "cancelled", startAt: string, endAt: string, amountPaidCents = 10000) {
  const vehicleId = await mkVehicle();
  const [b] = await db.insert(bookings).values({
    vehicleId, customerId, startAt, endAt, bufferEndAt: endAt, status,
    priceBreakdown: { subtotalCents: 10000, currency: "USD" },
    amountPaidCents,
    paymentOption: "full", acceptedPolicyVersion: 1, acceptedAt: new Date(),
    idempotencyKey: `today-${++n}`,
  }).returning();
  return b!;
}

beforeAll(async () => {
  db = await getDb();
  await runMigrations();
  const [c] = await db.insert(customers).values({ email: "today@example.com", name: "Toni Today" }).returning();
  customerId = c!.id;
});

describe("getToday", () => {
  it("returns today's handover, today's return, an overdue rental and an unpaid one, and never a cancelled booking", async () => {
    const handover = await mk("confirmed", at(day, "09:00"), at("2028-03-13", "09:00"));
    const ret = await mk("picked_up", at("2028-03-07", "09:00"), at(day, "16:00"));
    const overdue = await mk("picked_up", at("2028-03-05", "09:00"), at("2028-03-09", "16:00"));
    const unpaid = await mk("picked_up", at("2028-03-05", "09:00"), at("2028-03-14", "09:00"), 0);
    await mk("cancelled", at(day, "10:00"), at("2028-03-12", "10:00"));
    await mk("confirmed", at("2028-03-20", "10:00"), at("2028-03-22", "10:00"));

    const board = await getToday(day, now);
    const ids = board.items.map((i) => i.bookingId);
    expect(ids[0]).toBe(overdue.id);
    expect(ids).toContain(handover.id);
    expect(ids).toContain(ret.id);
    expect(ids).toContain(unpaid.id);
    expect(ids).toHaveLength(4);
    expect(board.items.find((i) => i.bookingId === handover.id)).toMatchObject({ plate: "TDY-001", vehicle: "Economy Hatchback", customer: "Toni Today" });
    expect(board.items.find((i) => i.bookingId === unpaid.id)).toMatchObject({ kind: "unpaid", unpaid: true, note: "Unpaid: $100.00 still due" });
  });
});
