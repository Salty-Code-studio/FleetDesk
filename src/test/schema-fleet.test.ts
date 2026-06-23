import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { vehicles, settings } from "@/lib/db/schema";
import { expectReject } from "./util";

let db: Awaited<ReturnType<typeof getDb>>;

beforeAll(async () => {
  db = await getDb();
  await runMigrations();
});

describe("fleet + settings schema", () => {
  it("inserts and reads a vehicle", async () => {
    await db.insert(vehicles).values({
      slug: "kia-picanto", plate: "PL-kia-picanto", class: "Economy", name: "Kia Picanto", seats: 4,
      transmission: "Automatic", doors: 4,
      priceDayCents: 3500, priceWeekCents: 21000, priceMonthCents: 72000,
    });
    const [row] = await db.select().from(vehicles).where(eq(vehicles.slug, "kia-picanto"));
    expect(row?.name).toBe("Kia Picanto");
    expect(row?.status).toBe("active");
    expect(row?.photos).toEqual([]);
    expect(row?.depositCents).toBeNull();
  });

  it("enforces unique slugs", async () => {
    await expectReject(db.insert(vehicles).values({
      slug: "kia-picanto", plate: "PL-kia-picanto", class: "Economy", name: "Dup", seats: 4,
      transmission: "Automatic", doors: 4,
      priceDayCents: 1, priceWeekCents: 1, priceMonthCents: 1,
    }), /unique|duplicate/i);
  });

  it("settings is a physical singleton (id must be 1)", async () => {
    await db.insert(settings).values({ id: 1 });
    await expectReject(db.insert(settings).values({ id: 2 }), /settings_singleton|check/i);
  });
});
