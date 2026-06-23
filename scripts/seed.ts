/**
 * Idempotent database seed — settings singleton, placeholder insurance tiers,
 * placeholder add-ons, and a small demo fleet. Safe to run repeatedly: every insert is onConflictDoNothing
 * keyed on natural uniques. Replace placeholder prices/cars when the owner
 * confirms their real fleet.
 *
 * Run: npm run db:seed   (applies pending migrations first)
 */
import { runMigrations } from "../src/lib/db/migrate";
import { getDb, closeDb } from "../src/lib/db/client";
import { settings, vehicles, insuranceTiers, addOns } from "../src/lib/db/schema";

// Demo fleet for first run. FleetDesk is multi-tenant-ready: each operator edits
// their real fleet, prices and add-ons in the admin. `plate` is the ops-board row
// ID (any unique identifier). Prices are flat per-class cents (operator-set);
// customers book a TYPE, and any car of that class costs the same.
const FLEET = [
  { slug: "economy-001", plate: "DEMO-001", class: "Economy", name: "Economy Hatchback", seats: 5, transmission: "Automatic", ac: true, doors: 5, priceDayCents: 3500, priceWeekCents: 21000, priceMonthCents: 70000, depositCents: 25000 },
  { slug: "economy-002", plate: "DEMO-002", class: "Economy", name: "Economy Hatchback", seats: 5, transmission: "Automatic", ac: true, doors: 5, priceDayCents: 3500, priceWeekCents: 21000, priceMonthCents: 70000, depositCents: 25000 },
  { slug: "economy-003", plate: "DEMO-003", class: "Economy", name: "Economy Sedan", seats: 5, transmission: "Automatic", ac: true, doors: 4, priceDayCents: 3500, priceWeekCents: 21000, priceMonthCents: 70000, depositCents: 25000 },
  { slug: "compact-001", plate: "DEMO-101", class: "Compact", name: "Compact Sedan", seats: 5, transmission: "Automatic", ac: true, doors: 4, priceDayCents: 4000, priceWeekCents: 24000, priceMonthCents: 80000, depositCents: 25000 },
  { slug: "compact-002", plate: "DEMO-102", class: "Compact", name: "Compact Sedan", seats: 5, transmission: "Automatic", ac: true, doors: 4, priceDayCents: 4000, priceWeekCents: 24000, priceMonthCents: 80000, depositCents: 25000 },
  { slug: "compact-003", plate: "DEMO-103", class: "Compact", name: "Compact SUV", seats: 5, transmission: "Automatic", ac: true, doors: 5, priceDayCents: 4000, priceWeekCents: 24000, priceMonthCents: 80000, depositCents: 25000 },
];

async function seed() {
  await runMigrations();
  const db = await getDb();

  await db.insert(settings).values({ id: 1, currency: "USD" }).onConflictDoNothing();

  await db.insert(vehicles).values(FLEET).onConflictDoNothing({ target: vehicles.slug });

  // Placeholder tiers/add-ons (spec §16: final list + prices from owner; all editable in the dashboard)
  const existingTiers = await db.select({ id: insuranceTiers.id }).from(insuranceTiers);
  if (existingTiers.length === 0) {
    await db.insert(insuranceTiers).values([
      { name: "Basic", dailyPriceCents: 0, coverage: "Included with every rental.", isDefault: true },
      { name: "Standard", dailyPriceCents: 800, coverage: "Lower excess, tire and glass cover." },
      { name: "Premium", dailyPriceCents: 1500, coverage: "Zero excess, full peace of mind." },
    ]);
  }

  const existingAddOns = await db.select({ id: addOns.id }).from(addOns);
  if (existingAddOns.length === 0) {
    await db.insert(addOns).values([
      { name: "Baby chair", priceCents: 500, pricing: "per_day", category: "family", stock: 3 },
      { name: "Cooler", priceCents: 700, pricing: "per_rental", category: "beach", stock: 5 },
      { name: "Snorkel set", priceCents: 1000, pricing: "per_rental", category: "beach", stock: 6 },
      { name: "Extra driver", priceCents: 1500, pricing: "per_rental", category: "driving", stock: null },
    ]);
  }

  console.log("Seed complete: settings, demo fleet, 3 insurance tiers, 4 add-ons.");
}

seed()
  .then(async () => { await closeDb(); process.exit(0); })
  .catch(async (e) => { console.error(e); await closeDb().catch(() => undefined); process.exit(1); });
