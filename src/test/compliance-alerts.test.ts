import { describe, it, expect, beforeAll } from "vitest";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { vehicles } from "@/lib/db/schema";
import { getSettings } from "@/lib/admin/settings";

let db: Awaited<ReturnType<typeof getDb>>;

beforeAll(async () => {
  db = await getDb();
  await runMigrations();
});

describe("compliance schema", () => {
  it("vehicles carry expiry dates and alert stages defaulting to 0", async () => {
    const [v] = await db.insert(vehicles).values({
      slug: "comp-schema-car", plate: "PL-COMP-1", class: "SUV", name: "Comp Car", seats: 5,
      transmission: "Automatic", doors: 5, priceDayCents: 1, priceWeekCents: 1, priceMonthCents: 1,
      insuranceExpiresOn: "2027-03-01", inspectionDueOn: "2027-06-15",
    }).returning();
    expect(v!.insuranceExpiresOn).toBe("2027-03-01");
    expect(v!.inspectionDueOn).toBe("2027-06-15");
    expect(v!.insuranceAlertStage).toBe(0);
    expect(v!.inspectionAlertStage).toBe(0);
  });

  it("a vehicle with no tracked dates stores nulls", async () => {
    const [v] = await db.insert(vehicles).values({
      slug: "comp-schema-bare", plate: "PL-COMP-0", class: "Economy", name: "Bare Car", seats: 4,
      transmission: "Manual", doors: 4, priceDayCents: 1, priceWeekCents: 1, priceMonthCents: 1,
    }).returning();
    expect(v!.insuranceExpiresOn).toBeNull();
    expect(v!.inspectionDueOn).toBeNull();
  });

  it("settings expose complianceAlertDays defaulting to 30", async () => {
    const s = await getSettings();
    expect(s.complianceAlertDays).toBe(30);
  });
});
