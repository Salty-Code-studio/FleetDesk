import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { vehicles } from "@/lib/db/schema";
import { getSettings, patchSettings, SettingsPatchSchema } from "@/lib/admin/settings";
import {
  createVehicle, updateVehicle, VehicleCreateSchema, VehiclePatchSchema,
} from "@/lib/admin/vehicles";
import { listNotifications } from "@/lib/admin/notifications-feed";
import { runComplianceAlerts, complianceOverview, daysUntil, targetStage } from "@/lib/admin/compliance";
import { GET as cronGet } from "@/app/api/cron/compliance-alerts/route";

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

describe("compliance staging math", () => {
  it("daysUntil counts whole calendar days, negative when past", () => {
    expect(daysUntil("2027-06-01", "2027-06-21")).toBe(20);
    expect(daysUntil("2027-06-01", "2027-06-01")).toBe(0);
    expect(daysUntil("2027-06-01", "2027-05-30")).toBe(-2);
  });

  it("targetStage ladders first-warning, one-week, overdue", () => {
    expect(targetStage(31, 30)).toBe(0);
    expect(targetStage(30, 30)).toBe(1);
    expect(targetStage(8, 30)).toBe(1);
    expect(targetStage(7, 30)).toBe(2);
    expect(targetStage(1, 30)).toBe(2);
    expect(targetStage(0, 30)).toBe(2);
    expect(targetStage(-1, 30)).toBe(3);
  });
});

describe("runComplianceAlerts", () => {
  // Fixed clocks: noon Aruba time (UTC-4) so the local calendar date is unambiguous.
  const NOW_20D = new Date("2027-06-01T12:00:00-04:00"); // 20 days before 2027-06-21
  const NOW_5D = new Date("2027-06-16T12:00:00-04:00");  // 5 days before
  const NOW_OVER = new Date("2027-06-23T12:00:00-04:00"); // 2 days past

  let cronCarId = "";
  const PLATE = "PL-CRON-1";
  const mine = async () =>
    (await listNotifications(200)).notifications.filter((n) => n.title.includes(PLATE));

  beforeAll(async () => {
    await patchSettings({ complianceAlertDays: 30 }); // pin the threshold for determinism
    const [v] = await db.insert(vehicles).values({
      slug: "comp-cron-car", plate: PLATE, class: "SUV", name: "Cron Car", seats: 5,
      transmission: "Automatic", doors: 5, priceDayCents: 1, priceWeekCents: 1, priceMonthCents: 1,
      insuranceExpiresOn: "2027-06-21",
    }).returning();
    cronCarId = v!.id;
  });

  it("fires the first warning once, with a warning-level bell", async () => {
    const r = await runComplianceAlerts(NOW_20D);
    expect(r.fired).toBeGreaterThanOrEqual(1); // other seeded cars may fire too
    const [row] = await db.select().from(vehicles).where(eq(vehicles.id, cronCarId));
    expect(row!.insuranceAlertStage).toBe(1);
    const notes = await mine();
    expect(notes.length).toBe(1);
    expect(notes[0]!.type).toBe("vehicle.document_expiring");
    expect(notes[0]!.level).toBe("warning");
    expect(notes[0]!.title).toContain("Insurance due soon");
  });

  it("is idempotent for the same day (stage dedup)", async () => {
    const r = await runComplianceAlerts(NOW_20D);
    expect(r.fired).toBe(0); // every vehicle's stage is already caught up
    expect((await mine()).length).toBe(1);
  });

  it("escalates to the one-week stage exactly once", async () => {
    await runComplianceAlerts(NOW_5D);
    const [row] = await db.select().from(vehicles).where(eq(vehicles.id, cronCarId));
    expect(row!.insuranceAlertStage).toBe(2);
    expect((await mine()).length).toBe(2);
    expect((await runComplianceAlerts(NOW_5D)).fired).toBe(0);
  });

  it("escalates to overdue with a critical bell", async () => {
    await runComplianceAlerts(NOW_OVER);
    const [row] = await db.select().from(vehicles).where(eq(vehicles.id, cronCarId));
    expect(row!.insuranceAlertStage).toBe(3);
    const notes = await mine();
    expect(notes.length).toBe(3);
    expect(notes[0]!.level).toBe("critical"); // newest first
    expect(notes[0]!.title).toContain("Insurance overdue");
  });

  it("a new future date (entered via updateVehicle) re-arms the ladder", async () => {
    await updateVehicle(cronCarId, { insuranceExpiresOn: "2028-06-21" });
    expect((await runComplianceAlerts(NOW_OVER)).fired).toBe(0); // far future: nothing to fire
    await runComplianceAlerts(new Date("2028-06-05T12:00:00-04:00")); // 16 days out next year
    const [row] = await db.select().from(vehicles).where(eq(vehicles.id, cronCarId));
    expect(row!.insuranceAlertStage).toBe(1);
    expect((await mine()).length).toBe(4);
  });

  it("skips untracked documents and retired vehicles entirely", async () => {
    await db.insert(vehicles).values({
      slug: "comp-cron-retired", plate: "PL-CRON-RET", class: "Van", name: "Retired Car", seats: 7,
      transmission: "Manual", doors: 5, priceDayCents: 1, priceWeekCents: 1, priceMonthCents: 1,
      status: "retired", insuranceExpiresOn: "2027-01-01",
    });
    await runComplianceAlerts(NOW_OVER);
    const notes = (await listNotifications(200)).notifications;
    expect(notes.some((n) => n.title.includes("PL-CRON-RET"))).toBe(false);
    expect(notes.some((n) => n.title.includes("PL-COMP-0"))).toBe(false); // the no-dates car from Task 1
  });

  it("self-heals a stale high stage when the date is far in the future", async () => {
    const [v] = await db.insert(vehicles).values({
      slug: "comp-cron-heal", plate: "PL-CRON-HEAL", class: "Compact", name: "Heal Car", seats: 4,
      transmission: "Manual", doors: 4, priceDayCents: 1, priceWeekCents: 1, priceMonthCents: 1,
      insuranceExpiresOn: "2030-01-01", insuranceAlertStage: 3,
    }).returning();
    await runComplianceAlerts(NOW_OVER);
    const [row] = await db.select().from(vehicles).where(eq(vehicles.id, v!.id));
    expect(row!.insuranceAlertStage).toBe(0);
    expect((await listNotifications(200)).notifications.some((n) => n.title.includes("PL-CRON-HEAL"))).toBe(false);
  });
});

describe("complianceOverview", () => {
  it("lists due-soon and overdue documents sorted by urgency, excluding far-future and retired", async () => {
    const NOW = new Date("2027-06-23T12:00:00-04:00");
    const { items } = await complianceOverview(NOW);
    expect(items.length).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < items.length; i++) {
      expect(items[i]!.daysLeft).toBeGreaterThanOrEqual(items[i - 1]!.daysLeft);
    }
    const heal = items.find((i) => i.plate === "PL-CRON-HEAL");
    expect(heal).toBeUndefined(); // 2030 is far outside the window
    expect(items.some((i) => i.plate === "PL-CRON-RET")).toBe(false); // retired
    const schemaCar = items.find((i) => i.plate === "PL-COMP-1" && i.kind === "insurance");
    expect(schemaCar).toBeDefined(); // 2027-03-01 is overdue at NOW
    expect(schemaCar!.daysLeft).toBeLessThan(0);
    expect(schemaCar!.dueOn).toBe("2027-03-01");
    expect(schemaCar!.name).toBe("Comp Car");
    expect(typeof schemaCar!.vehicleId).toBe("string");
  });
});

describe("cron route GET /api/cron/compliance-alerts", () => {
  it("refuses to run without the CRON_SECRET bearer", async () => {
    const bare = await cronGet(new Request("http://localhost/api/cron/compliance-alerts"));
    expect(bare.status).toBe(401);
    // In tests CRON_SECRET is unset (empty), so even a matching empty bearer
    // must be refused: the endpoint fails closed when no secret is configured.
    const empty = await cronGet(new Request("http://localhost/api/cron/compliance-alerts", {
      headers: { authorization: "Bearer " },
    }));
    expect(empty.status).toBe(401);
    const wrong = await cronGet(new Request("http://localhost/api/cron/compliance-alerts", {
      headers: { authorization: "Bearer nope" },
    }));
    expect(wrong.status).toBe(401);
  });
});
