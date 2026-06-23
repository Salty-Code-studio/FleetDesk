/**
 * Fleet planning board data: vehicles grouped by class, each with the bookings,
 * availability blocks, and blackout windows that touch a date range. Powers the
 * visual dashboard timeline (rows = cars by category, columns = days).
 */
import { and, eq, ne, lt, gt, inArray, asc } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { vehicles, bookings, customers, availabilityBlocks, blackoutDates } from "@/lib/db/schema";

export interface PlanningBar {
  id: string;
  start: string; // YYYY-MM-DD
  end: string;   // exclusive
  status: string;
  source: string; // online | manual
  label: string;
  notes: string | null;
}
export interface PlanningBlock {
  id: string; start: string; end: string; type: string; reason: string;
}
export interface PlanningVehicle {
  id: string; name: string; slug: string; plate: string; class: string;
  bookings: PlanningBar[];
  blocks: PlanningBlock[];
}
export interface PlanningCategory { class: string; vehicles: PlanningVehicle[] }
export interface Planning {
  from: string; to: string; days: string[];
  categories: PlanningCategory[];
  blackouts: { id: string; start: string; end: string; reason: string }[];
}

const CLASS_ORDER = ["Economy", "Compact", "SUV", "4x4", "Van"];

export function dayRange(from: string, to: string): string[] {
  const days: string[] = [];
  let t = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  while (t <= end) {
    days.push(new Date(t).toISOString().slice(0, 10));
    t += 86_400_000;
  }
  return days;
}

export async function getPlanning(from: string, to: string): Promise<Planning> {
  const db = await getDb();
  const toExclusive = new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

  const vehicleRows = await db.select().from(vehicles)
    .where(ne(vehicles.status, "retired"))
    .orderBy(asc(vehicles.class), asc(vehicles.name));

  const bookingRows = await db.select({
    id: bookings.id, vehicleId: bookings.vehicleId, start: bookings.startDate, end: bookings.endDate,
    status: bookings.status, source: bookings.source, notes: bookings.notes,
    customerName: customers.name, customerEmail: customers.email,
  }).from(bookings)
    .innerJoin(customers, eq(bookings.customerId, customers.id))
    .where(and(
      inArray(bookings.status, ["pending", "confirmed", "completed"]),
      lt(bookings.startDate, toExclusive),
      gt(bookings.endDate, from),
    ));

  const blockRows = await db.select().from(availabilityBlocks)
    .where(and(lt(availabilityBlocks.startDate, toExclusive), gt(availabilityBlocks.endDate, from)));

  const blackoutRows = await db.select().from(blackoutDates)
    .where(and(lt(blackoutDates.startDate, toExclusive), gt(blackoutDates.endDate, from)));

  const byVehicle = new Map<string, PlanningVehicle>();
  for (const v of vehicleRows) {
    byVehicle.set(v.id, { id: v.id, name: v.name, slug: v.slug, plate: v.plate, class: v.class, bookings: [], blocks: [] });
  }
  for (const b of bookingRows) {
    const pv = byVehicle.get(b.vehicleId);
    if (pv) pv.bookings.push({
      id: b.id, start: b.start, end: b.end, status: b.status, source: b.source,
      label: b.customerName || b.customerEmail.split("@")[0]!, notes: b.notes,
    });
  }
  for (const bl of blockRows) {
    const pv = byVehicle.get(bl.vehicleId);
    if (pv) pv.blocks.push({ id: bl.id, start: bl.startDate, end: bl.endDate, type: bl.type, reason: bl.reason });
  }

  // Group into ordered categories.
  const classes = [...new Set(vehicleRows.map((v) => v.class))].sort((a, b) => {
    const ia = CLASS_ORDER.indexOf(a), ib = CLASS_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const categories: PlanningCategory[] = classes.map((cls) => ({
    class: cls,
    vehicles: vehicleRows.filter((v) => v.class === cls).map((v) => byVehicle.get(v.id)!),
  }));

  return {
    from, to, days: dayRange(from, to), categories,
    blackouts: blackoutRows.map((b) => ({ id: b.id, start: b.startDate, end: b.endDate, reason: b.reason })),
  };
}
