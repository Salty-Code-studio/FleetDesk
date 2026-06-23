import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { vehicles, customers, bookings, availabilityBlocks } from "@/lib/db/schema";
import { expectReject } from "./util";

let db: Awaited<ReturnType<typeof getDb>>;
let vehicleId = "";

beforeAll(async () => {
  db = await getDb();
  await runMigrations();
  const [v] = await db.insert(vehicles).values({
    slug: "ops-car", plate: "A-1234", class: "SUV", name: "Ops Car", seats: 5, transmission: "Automatic",
    doors: 5, priceDayCents: 5800, priceWeekCents: 34800, priceMonthCents: 118000,
  }).returning();
  vehicleId = v!.id;
});

describe("ops board schema", () => {
  it("enforces a unique plate (registration is the row ID)", async () => {
    await expectReject(db.insert(vehicles).values({
      slug: "ops-car-dup", plate: "A-1234", class: "SUV", name: "Dup Plate", seats: 5, transmission: "Automatic",
      doors: 5, priceDayCents: 1, priceWeekCents: 1, priceMonthCents: 1,
    }), /unique|duplicate/i);
  });

  it("defaults a block to type 'other' and accepts the fixed types", async () => {
    const [b] = await db.insert(availabilityBlocks).values({
      vehicleId, startDate: "2027-02-01", endDate: "2027-02-03",
    }).returning();
    expect(b!.type).toBe("other");
    const [wash] = await db.insert(availabilityBlocks).values({
      vehicleId, startDate: "2027-02-10", endDate: "2027-02-11", type: "carwash", reason: "Weekly wash",
    }).returning();
    expect(wash!.type).toBe("carwash");
  });

  it("rejects an unknown block type", async () => {
    await expectReject(
      db.execute(
        `INSERT INTO availability_blocks (vehicle_id, start_date, end_date, type)
         VALUES ('${vehicleId}', '2027-03-01', '2027-03-02', 'spaceship')` as never,
      ),
      /invalid input value|block_type/i,
    );
  });

  it("defaults a booking's source to 'online' and accepts 'manual' with notes", async () => {
    const [c] = await db.insert(customers).values({ email: "ops@test.com" }).returning();
    const [online] = await db.insert(bookings).values({
      vehicleId, customerId: c!.id, startDate: "2027-04-01", endDate: "2027-04-05", bufferEndDate: "2027-04-06",
      status: "confirmed", priceBreakdown: {}, paymentOption: "reservation_fee",
      acceptedPolicyVersion: 1, acceptedAt: new Date(), idempotencyKey: "ops-online",
    }).returning();
    expect(online!.source).toBe("online");
    expect(online!.notes).toBeNull();

    const [manual] = await db.insert(bookings).values({
      vehicleId, customerId: c!.id, startDate: "2027-05-01", endDate: "2027-05-05", bufferEndDate: "2027-05-06",
      status: "confirmed", source: "manual", notes: "Walk-in, paid cash at desk",
      priceBreakdown: {}, paymentOption: "reservation_fee",
      acceptedPolicyVersion: 1, acceptedAt: new Date(), idempotencyKey: "ops-manual",
    }).returning();
    expect(manual!.source).toBe("manual");
    expect(manual!.notes).toBe("Walk-in, paid cash at desk");

    const [row] = await db.select().from(bookings).where(eq(bookings.id, manual!.id));
    expect(row!.source).toBe("manual");
  });
});
