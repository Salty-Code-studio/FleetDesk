import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { vehicles, settings } from "@/lib/db/schema";
import { publicQuote, publicBookingConfig } from "@/lib/booking/public";

let db: Awaited<ReturnType<typeof getDb>>;

const TODAY = "2026-06-15";
const START = "2027-02-01T09:00:00-04:00";
const END = "2027-02-08T09:00:00-04:00"; // 7 rental days

beforeAll(async () => {
  db = await getDb();
  await runMigrations();
  await db.insert(settings).values({ id: 1 }).onConflictDoNothing();
  // Pin the values this suite depends on; earlier test files share the database
  // and may have patched settings.
  await db.update(settings)
    .set({ minDriverAge: 18, youngDriverAge: 21, youngDriverFeeCentsPerDay: 1000 })
    .where(eq(settings.id, 1));
  await db.insert(vehicles).values({
    slug: "yd-car", plate: "PL-yd-car", class: "SUV", name: "YD Car", seats: 5, transmission: "Automatic",
    doors: 5, priceDayCents: 5800, priceWeekCents: 34800, priceMonthCents: 118000, depositCents: 25000,
  });
});

describe("publicBookingConfig", () => {
  it("exposes the non-sensitive age-band settings for the wizard", async () => {
    const cfg = await publicBookingConfig();
    expect(cfg.minDriverAge).toBe(18);
    expect(cfg.youngDriverAge).toBe(21);
    expect(cfg.youngDriverFeeCentsPerDay).toBe(1000);
    expect(typeof cfg.currency).toBe("string");
    // nothing else leaks (no admin recipients, no retention settings)
    expect(Object.keys(cfg).sort()).toEqual(["currency", "minDriverAge", "youngDriverAge", "youngDriverFeeCentsPerDay"]);
  });
});

describe("publicQuote young driver", () => {
  it("prices the fee when the claimed band is young", async () => {
    const b = await publicQuote({ vehicleSlug: "yd-car", startAt: START, endAt: END, youngDriver: true }, TODAY);
    expect(b.youngDriver).toBe(true);
    expect(b.youngDriverCents).toBe(7 * 1000);
    expect(b.subtotalCents).toBe(b.vehicleCents + b.insuranceCents + b.addOnsCents + 7000);
  });

  it("prices no fee when the flag is omitted", async () => {
    const b = await publicQuote({ vehicleSlug: "yd-car", startAt: START, endAt: END }, TODAY);
    expect(b.youngDriver).toBe(false);
    expect(b.youngDriverCents).toBe(0);
  });
});
