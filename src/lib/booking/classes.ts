/**
 * Class-level view of the fleet for the public booking flow. Customers book a
 * TYPE (Economy / Compact), not an individual car — so this groups active
 * vehicles by class, exposes the (flat) per-class day rate, and when dates are
 * given, resolves ONE available car of each class to actually hold. Pricing is
 * flat within a class, so whichever car is assigned, the customer pays the same.
 */
import { ne, asc } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { vehicles } from "@/lib/db/schema";
import { checkAvailability } from "@/lib/booking/availability";
import { getSettings } from "@/lib/admin/settings";

const CLASS_ORDER = ["Economy", "Compact", "SUV", "4x4", "Van"];

export interface ClassOption {
  class: string;
  fromDayCents: number;
  depositCents: number | null;
  cars: number;
  available: boolean | null;  // null when no dates were given
  carSlug: string | null;     // a resolved free car of this class for the window
}

export async function getClasses(pickup?: string, end?: string): Promise<ClassOption[]> {
  const db = await getDb();
  const rows = await db.select().from(vehicles)
    .where(ne(vehicles.status, "retired"))
    .orderBy(asc(vehicles.priceDayCents));

  const byClass = new Map<string, typeof rows>();
  for (const v of rows) {
    if (!byClass.has(v.class)) byClass.set(v.class, []);
    byClass.get(v.class)!.push(v);
  }

  const settings = await getSettings();
  const datesGiven = !!(pickup && end && end > pickup);
  const out: ClassOption[] = [];

  for (const [cls, cars] of byClass) {
    const fromDayCents = Math.min(...cars.map((c) => c.priceDayCents));
    const depositCents = cars.find((c) => c.depositCents != null)?.depositCents ?? null;
    let carSlug: string | null = null;
    if (datesGiven) {
      for (const c of cars) {
        const a = await checkAvailability(c.id, pickup!, end!, { turnaroundBufferHours: settings.turnaroundBufferHours });
        if (a.available) { carSlug = c.slug; break; }
      }
    }
    out.push({
      class: cls, fromDayCents, depositCents, cars: cars.length,
      available: datesGiven ? carSlug != null : null,
      carSlug,
    });
  }

  out.sort((a, b) => {
    const ia = CLASS_ORDER.indexOf(a.class), ib = CLASS_ORDER.indexOf(b.class);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  return out;
}
