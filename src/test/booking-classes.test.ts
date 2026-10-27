import { describe, it, expect, beforeAll } from "vitest";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { vehicles, settings } from "@/lib/db/schema";
import { getClasses } from "@/lib/booking/classes";

const car = (slug: string, cls: string, priceDayCents: number, photos: string[]) => ({
  slug, plate: `PL-${slug}`, class: cls, name: slug, seats: 5, transmission: "Automatic", doors: 5,
  priceDayCents, priceWeekCents: priceDayCents * 6, priceMonthCents: priceDayCents * 20, photos,
});

beforeAll(async () => {
  const db = await getDb();
  await runMigrations();
  await db.insert(settings).values({ id: 1 }).onConflictDoNothing();
  await db.insert(vehicles).values([
    car("cls-van-a", "Hero Van", 9000, []),
    car("cls-van-b", "Hero Van", 9500, ["/fleet/van-b.jpg", "/fleet/van-b2.jpg"]),
    car("cls-bare", "Hero Bare", 4000, []),
  ]);
});

describe("getClasses photo", () => {
  it("uses the first photo of the cheapest car that has one, else null", async () => {
    const out = await getClasses();
    expect(out.find((c) => c.class === "Hero Van")?.photo).toBe("/fleet/van-b.jpg");
    expect(out.find((c) => c.class === "Hero Bare")?.photo).toBeNull();
  });
});
