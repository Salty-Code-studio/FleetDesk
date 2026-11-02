/**
 * Local-only fake data so the redesigned desk has something to show:
 * a bigger fleet, ~35 customers and bookings spread from three weeks ago to
 * three weeks ahead, in every state (pending, confirmed, out, back, cancelled),
 * with full, partial and missing payments. Run AFTER db:seed and demo:admin.
 *
 * Run: node --import tsx --env-file-if-exists=.env.local scripts/seed-demo-data.ts
 * Refuses to run against anything but the local pglite database.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { sql, eq } from "drizzle-orm";
import { getDb, closeDb } from "../src/lib/db/client";
import { vehicles, bookings, payments, settings, policies } from "../src/lib/db/schema";
import { createManualBooking } from "../src/lib/admin/manual-booking";

if (!process.env.DATABASE_URL?.startsWith("pglite://")) {
  console.error("Refusing: seed-demo-data only runs on the local pglite database.");
  process.exit(1);
}

const EXTRA_FLEET = [
  { slug: "economy-004", plate: "B-4471", class: "Economy", name: "Kia Picanto", make: "Kia", model: "Picanto", year: 2024, color: "White", seats: 4, doors: 5, priceDayCents: 3500, priceWeekCents: 21000, priceMonthCents: 70000, depositCents: 25000 },
  { slug: "economy-005", plate: "B-5120", class: "Economy", name: "Hyundai i10", make: "Hyundai", model: "i10", year: 2023, color: "Silver", seats: 4, doors: 5, priceDayCents: 3500, priceWeekCents: 21000, priceMonthCents: 70000, depositCents: 25000 },
  { slug: "compact-004", plate: "B-6034", class: "Compact", name: "Toyota Yaris", make: "Toyota", model: "Yaris", year: 2024, color: "Red", seats: 5, doors: 5, priceDayCents: 4000, priceWeekCents: 24000, priceMonthCents: 80000, depositCents: 25000 },
  { slug: "suv-001", plate: "B-7712", class: "SUV", name: "Suzuki Jimny", make: "Suzuki", model: "Jimny", year: 2024, color: "Sand", seats: 4, doors: 3, priceDayCents: 6500, priceWeekCents: 39000, priceMonthCents: 130000, depositCents: 50000 },
  { slug: "suv-002", plate: "B-7713", class: "SUV", name: "Suzuki Jimny", make: "Suzuki", model: "Jimny", year: 2023, color: "Jungle green", seats: 4, doors: 3, priceDayCents: 6500, priceWeekCents: 39000, priceMonthCents: 130000, depositCents: 50000 },
  { slug: "suv-003", plate: "B-8090", class: "SUV", name: "Toyota RAV4", make: "Toyota", model: "RAV4", year: 2024, color: "Grey", seats: 5, doors: 5, priceDayCents: 7500, priceWeekCents: 45000, priceMonthCents: 150000, depositCents: 50000 },
  { slug: "pickup-001", plate: "B-9301", class: "Pickup", name: "Toyota Hilux", make: "Toyota", model: "Hilux", year: 2023, color: "White", seats: 5, doors: 4, priceDayCents: 8500, priceWeekCents: 51000, priceMonthCents: 170000, depositCents: 75000 },
  { slug: "van-001", plate: "B-9455", class: "Van", name: "Toyota Hiace", make: "Toyota", model: "Hiace", year: 2022, color: "White", seats: 9, doors: 4, priceDayCents: 9500, priceWeekCents: 57000, priceMonthCents: 190000, depositCents: 75000 },
].map((v) => ({ ...v, transmission: "Automatic", ac: true }));

const PEOPLE: [string, string][] = [
  ["Sanne de Vries", "+31 6 1234 5678"], ["Marco Rossi", "+39 333 120 4455"], ["Emily Carter", "+1 305 555 0142"],
  ["Jurgen Martis", "+599 717 2231"], ["Lisa Janssen", "+31 6 2233 4455"], ["Tom Bakker", "+31 6 9876 5432"],
  ["Ana Lucia Pinto", "+55 21 99876 1234"], ["Kevin O'Brien", "+1 617 555 0199"], ["Sophie Müller", "+49 151 2345 6789"],
  ["Ricardo Winklaar", "+599 785 4410"], ["Noah Peters", "+31 6 4455 6677"], ["Isabella Gomez", "+57 310 555 2211"],
  ["David Chen", "+1 415 555 0177"], ["Femke Visser", "+31 6 5566 7788"], ["Luca Bianchi", "+39 347 555 8899"],
  ["Rachel Adams", "+1 212 555 0133"], ["Gerold Thode", "+599 796 1188"], ["Mila Smit", "+31 6 6677 8899"],
  ["James Walker", "+44 7700 900123"], ["Chantal Cicilia", "+599 795 3344"], ["Pieter Hendriks", "+31 6 7788 9900"],
  ["Olivia Brown", "+1 786 555 0166"], ["Daan Mulder", "+31 6 8899 0011"], ["Camila Torres", "+58 412 555 6677"],
  ["Ethan Wright", "+1 954 555 0188"], ["Eva de Graaf", "+31 6 1122 3344"], ["Shurendy Anthony", "+599 701 5566"],
  ["Hannah Schmidt", "+49 160 555 4433"], ["Bram Koster", "+31 6 2211 3344"], ["Grace Lee", "+1 646 555 0155"],
  ["Thijs van Dijk", "+31 6 3344 1122"], ["Natalia Rojas", "+57 300 555 7788"], ["Michael Ross", "+1 312 555 0122"],
  ["Julia Vermeulen", "+31 6 4433 2211"], ["Rodney Frans", "+599 790 6677"],
];

const DAY = 86_400_000;
// The desk runs on island time (America/Aruba, UTC-4, no DST): anchor "today" there.
const islandDay = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Aruba" }).format(new Date());
const today = new Date(`${islandDay}T00:00:00-04:00`);
/** Day offset from today at a given hour, as ISO. */
const at = (dayOffset: number, hour: number) => new Date(today.getTime() + dayOffset * DAY + hour * 3_600_000).toISOString();

type Plan = { car: string; from: number; fromH: number; to: number; toH: number; paid: "full" | "part" | "none"; status?: "pending" | "cancelled"; note?: string };

// Per car: a believable run of rentals. Past = completed, spanning now = out,
// future = confirmed. "status" overrides for pending / cancelled.
const PLANS: Plan[] = [
  { car: "DEMO-001", from: -18, fromH: 10, to: -11, toH: 10, paid: "full" },
  { car: "DEMO-001", from: -9, fromH: 9, to: -2, toH: 17, paid: "full" },
  { car: "DEMO-001", from: 0, fromH: 10, to: 7, toH: 10, paid: "part", note: "Arriving on KLM 735, pick up at airport desk" },
  { car: "DEMO-001", from: 10, fromH: 9, to: 17, toH: 9, paid: "none" },
  { car: "DEMO-002", from: -14, fromH: 11, to: -7, toH: 11, paid: "full" },
  { car: "DEMO-002", from: -5, fromH: 9, to: 3, toH: 12, paid: "full" },
  { car: "DEMO-002", from: 5, fromH: 14, to: 12, toH: 10, paid: "full" },
  { car: "DEMO-003", from: -12, fromH: 10, to: -4, toH: 10, paid: "full" },
  { car: "DEMO-003", from: -2, fromH: 8, to: 0, toH: 16, paid: "part", note: "Return today, check fuel" },
  { car: "DEMO-003", from: 2, fromH: 10, to: 9, toH: 10, paid: "none", status: "pending" },
  { car: "DEMO-101", from: -20, fromH: 9, to: -13, toH: 9, paid: "full" },
  { car: "DEMO-101", from: -10, fromH: 12, to: -3, toH: 12, paid: "full" },
  { car: "DEMO-101", from: -1, fromH: 9, to: 6, toH: 9, paid: "none", note: "Pays cash at return" },
  { car: "DEMO-101", from: 8, fromH: 10, to: 15, toH: 10, paid: "part" },
  { car: "DEMO-102", from: -7, fromH: 10, to: 0, toH: 11, paid: "full", note: "Return today 11:00" },
  { car: "DEMO-102", from: 1, fromH: 14, to: 8, toH: 14, paid: "full" },
  { car: "DEMO-102", from: 12, fromH: 15, to: 19, toH: 10, paid: "none", status: "cancelled" },
  { car: "DEMO-103", from: -16, fromH: 10, to: -9, toH: 10, paid: "full" },
  { car: "DEMO-103", from: -3, fromH: 14, to: 4, toH: 14, paid: "full" },
  { car: "DEMO-103", from: 6, fromH: 10, to: 13, toH: 10, paid: "part" },
  { car: "B-4471", from: -6, fromH: 9, to: -1, toH: 9, paid: "full" },
  { car: "B-4471", from: 0, fromH: 14, to: 5, toH: 14, paid: "none", note: "Walk-in, wants baby chair" },
  { car: "B-5120", from: -11, fromH: 10, to: -5, toH: 10, paid: "full" },
  { car: "B-5120", from: 3, fromH: 9, to: 10, toH: 9, paid: "full" },
  { car: "B-6034", from: -4, fromH: 11, to: 2, toH: 11, paid: "part" },
  { car: "B-6034", from: 4, fromH: 10, to: 11, toH: 10, paid: "none", status: "pending" },
  { car: "B-7712", from: -15, fromH: 9, to: -8, toH: 9, paid: "full" },
  { car: "B-7712", from: -2, fromH: 10, to: 5, toH: 10, paid: "full", note: "Washington Slagbaai park permit" },
  { car: "B-7712", from: 7, fromH: 10, to: 14, toH: 10, paid: "part" },
  { car: "B-7713", from: 0, fromH: 9, to: 4, toH: 9, paid: "full", note: "Pick up 09:00, hotel Delfins" },
  { car: "B-7713", from: 9, fromH: 10, to: 16, toH: 10, paid: "none" },
  { car: "B-8090", from: -9, fromH: 10, to: -2, toH: 10, paid: "full" },
  { car: "B-8090", from: 1, fromH: 13, to: 15, toH: 13, paid: "part", note: "Two-week family trip" },
  { car: "B-9301", from: -30, fromH: 9, to: 30, toH: 9, paid: "part", note: "Monthly, dive shop. Pays per month" },
  { car: "B-9455", from: -5, fromH: 10, to: -1, toH: 10, paid: "full" },
  { car: "B-9455", from: 2, fromH: 8, to: 5, toH: 18, paid: "full", note: "Wedding group, 9 seats" },
];

function dayRate(v: { priceDayCents: number; priceWeekCents: number | null; priceMonthCents: number | null }, days: number) {
  if (days >= 28 && v.priceMonthCents) return Math.round((v.priceMonthCents / 30) * days);
  if (days >= 7 && v.priceWeekCents) return Math.round((v.priceWeekCents / 7) * days);
  return v.priceDayCents * days;
}

async function main() {
  const db = await getDb();
  // Island norm: 21 to rent, young driver fee under 25.
  await db.update(settings).set({ currency: "USD", minDriverAge: 21, youngDriverAge: 25, youngDriverFeeCentsPerDay: 1000 }).where(eq(settings.id, 1));
  // Demo rules, cancellation and privacy text (scripts/demo-policies), once.
  for (const type of ["rental_terms", "cancellation", "privacy"] as const) {
    const [have] = await db.select({ id: policies.id }).from(policies).where(eq(policies.type, type));
    if (!have) {
      const body = readFileSync(path.join(__dirname, "demo-policies", `${type}.txt`), "utf8").trim();
      await db.insert(policies).values({ type, version: 1, body, publishedAt: new Date() });
    }
  }
  await db.insert(vehicles).values(EXTRA_FLEET).onConflictDoNothing({ target: vehicles.slug });
  // Give the stock demo cars real makes so cards read like a real fleet.
  const named: Record<string, [string, string, string, number]> = {
    "DEMO-001": ["Kia", "Picanto", "Blue", 2023], "DEMO-002": ["Kia", "Rio", "White", 2024], "DEMO-003": ["Nissan", "Almera", "Silver", 2023],
    "DEMO-101": ["Toyota", "Corolla", "Black", 2024], "DEMO-102": ["Honda", "City", "White", 2023], "DEMO-103": ["Hyundai", "Creta", "Red", 2024],
  };
  for (const [plate, [make, model, color, year]] of Object.entries(named)) {
    await db.update(vehicles).set({ make, model, color, year, name: `${make} ${model}` }).where(eq(vehicles.plate, plate));
  }

  const existing = await db.select({ n: sql<number>`count(*)::int` }).from(bookings);
  if ((existing[0]?.n ?? 0) > 0) {
    console.log(`Bookings already exist (${existing[0]!.n}); skipping bookings. Delete .dev-db to start fresh.`);
    return;
  }

  const fleet = await db.select().from(vehicles);
  const byPlate = new Map(fleet.map((v) => [v.plate, v]));
  const now = Date.now();
  let i = 0;
  for (const p of PLANS) {
    const v = byPlate.get(p.car);
    if (!v) throw new Error(`No car ${p.car}`);
    const [name, phone] = PEOPLE[i % PEOPLE.length]!;
    i++;
    const startAt = at(p.from, p.fromH), endAt = at(p.to, p.toH);
    const days = Math.max(1, Math.round((Date.parse(endAt) - Date.parse(startAt)) / DAY));
    const price = dayRate(v, days);
    const email = `${name.toLowerCase().replace(/[^a-z]+/g, ".").replace(/^\.|\.$/g, "")}@example.com`;
    const b = await createManualBooking({ vehicleId: v.id, startAt, endAt, customerName: name, customerPhone: phone, customerEmail: email, priceCents: price, notes: p.note, override: true });

    let status: "pending" | "confirmed" | "picked_up" | "completed" | "cancelled" = "confirmed";
    if (p.status) status = p.status;
    else if (Date.parse(endAt) < now) status = "completed";
    else if (Date.parse(startAt) <= now) status = "picked_up";

    const paidCents = p.paid === "full" ? price : p.paid === "part" ? Math.round(price * 0.3 / 100) * 100 : 0;
    await db.update(bookings).set({ status, amountPaidCents: status === "cancelled" ? 0 : paidCents, source: i % 3 === 0 ? "manual" : "online" }).where(eq(bookings.id, b.id));
    if (paidCents > 0 && status !== "cancelled") {
      const online = i % 3 !== 0;
      await db.insert(payments).values({
        bookingId: b.id, type: p.paid === "full" ? "rental_full" : "rental_deposit",
        method: online ? "stripe" : "desk", amountCents: paidCents, currency: "USD", status: "succeeded",
        stripePaymentIntentId: online ? `pi_demo_${b.id.slice(0, 12)}` : null,
        createdAt: new Date(Math.min(now, Date.parse(startAt)) - 2 * DAY),
      });
    }
  }
  console.log(`Fake data ready: ${fleet.length} cars, ${PLANS.length} bookings.`);
}

main()
  .then(async () => { await closeDb(); process.exit(0); })
  .catch(async (e) => { console.error(e); await closeDb().catch(() => undefined); process.exit(1); });
