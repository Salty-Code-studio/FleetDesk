import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { vehicles } from "@/lib/db/schema";
import { getSettings, patchSettings, SettingsPatchSchema } from "@/lib/admin/settings";
import {
  createVehicle, updateVehicle, VehicleCreateSchema, VehiclePatchSchema,
} from "@/lib/admin/vehicles";

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

describe("compliance fields at the vehicle API boundary", () => {
  it("accepts and persists expiry dates through create", async () => {
    const input = VehicleCreateSchema.parse({
      slug: "comp-val-car", plate: "PL-COMP-2", class: "Economy", name: "Val Car", seats: 4,
      transmission: "Manual", doors: 4, priceDayCents: 1000, priceWeekCents: 6000, priceMonthCents: 20000,
      insuranceExpiresOn: "2027-05-01",
    });
    const v = await createVehicle(input);
    expect(v.insuranceExpiresOn).toBe("2027-05-01");
    expect(v.inspectionDueOn).toBeNull();
  });

  it("rejects an impossible calendar date", () => {
    expect(VehiclePatchSchema.safeParse({ insuranceExpiresOn: "2027-02-30" }).success).toBe(false);
    expect(VehiclePatchSchema.safeParse({ inspectionDueOn: "not-a-date" }).success).toBe(false);
  });

  it("changing a date resets ONLY that document's alert stage", async () => {
    const [v] = await db.insert(vehicles).values({
      slug: "comp-reset-car", plate: "PL-COMP-3", class: "SUV", name: "Reset Car", seats: 5,
      transmission: "Automatic", doors: 5, priceDayCents: 1, priceWeekCents: 1, priceMonthCents: 1,
      insuranceExpiresOn: "2027-01-01", inspectionDueOn: "2027-02-01",
    }).returning();
    await db.update(vehicles)
      .set({ insuranceAlertStage: 2, inspectionAlertStage: 2 })
      .where(eq(vehicles.id, v!.id));

    const after = await updateVehicle(v!.id, { insuranceExpiresOn: "2028-01-01" });
    expect(after.insuranceAlertStage).toBe(0);   // reset: the date changed
    expect(after.inspectionAlertStage).toBe(2);  // untouched: its date did not change
  });

  it("an unrelated patch leaves both stages alone", async () => {
    const input = VehicleCreateSchema.parse({
      slug: "comp-noreset-car", plate: "PL-COMP-4", class: "Van", name: "NoReset Car", seats: 7,
      transmission: "Automatic", doors: 5, priceDayCents: 1000, priceWeekCents: 6000, priceMonthCents: 20000,
      insuranceExpiresOn: "2027-04-01",
    });
    const v = await createVehicle(input);
    await db.update(vehicles).set({ insuranceAlertStage: 1 }).where(eq(vehicles.id, v.id));
    const after = await updateVehicle(v.id, { name: "NoReset Car Renamed" });
    expect(after.insuranceAlertStage).toBe(1);
  });

  it("re-sending the SAME date does not reset the stage", async () => {
    const [row] = await db.select().from(vehicles).where(eq(vehicles.slug, "comp-noreset-car"));
    const after = await updateVehicle(row!.id, { insuranceExpiresOn: "2027-04-01" });
    expect(after.insuranceAlertStage).toBe(1);
  });

  it("settings accept complianceAlertDays within 1..365", async () => {
    expect(SettingsPatchSchema.safeParse({ complianceAlertDays: 0 }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ complianceAlertDays: 366 }).success).toBe(false);
    const s = await patchSettings({ complianceAlertDays: 45 });
    expect(s.complianceAlertDays).toBe(45);
    await patchSettings({ complianceAlertDays: 30 }); // restore the default for later tests
  });
});
