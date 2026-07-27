/**
 * Owner-facing numbers for the Reports page. Aggregated in JS (not SQL) because
 * the fleet is small and it keeps the booking JSON math identical across the
 * PGlite (dev) and Postgres (prod) drivers. "Revenue" = the rental subtotal
 * snapshotted on each confirmed/completed booking (priceBreakdown.subtotalCents);
 * cancelled bookings never count.
 */
import { inArray } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { vehicles, bookings } from "@/lib/db/schema";
import { getSettings } from "@/lib/admin/settings";
import { arubaDateOf } from "@/lib/time/format";

export interface ReportKpis {
  revenueAllCents: number;
  revenueMonthCents: number;
  rentalsThisMonth: number;
  activeRentals: number;
  utilizationPct: number; // % of active-fleet car-days booked over the next 30 days
  idleCars: number;       // active cars with no rental in the next 30 days
}
export interface Reports {
  currency: string;
  month: string; // YYYY-MM (Aruba "this month")
  kpis: ReportKpis;
  revenueByMonth: { month: string; cents: number }[]; // last 6 months, chronological
  revenueByClass: { class: string; cents: number }[]; // desc
  topVehicles: { plate: string; name: string; cents: number; rentals: number }[]; // top 5
}

const REVENUE_STATUSES = ["confirmed", "completed"] as const;
const OCCUPANCY_STATUSES = ["pending", "confirmed"] as const;

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const monthOffset = (today: string, back: number) => {
  const [y, m] = today.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1 - back, 1)).toISOString().slice(0, 7);
};
function overlapDays(s: string, e: string, winStart: string, winEnd: string): number {
  const a = s > winStart ? s : winStart;
  const b = e < winEnd ? e : winEnd;
  return Math.max(0, (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export async function getReports(today: string): Promise<Reports> {
  const db = await getDb();
  const settings = await getSettings();

  const vrows = await db.select({
    id: vehicles.id, plate: vehicles.plate, name: vehicles.name, class: vehicles.class, status: vehicles.status,
  }).from(vehicles);
  const activeVehicles = vrows.filter((v) => v.status !== "retired");
  const vById = new Map(vrows.map((v) => [v.id, v]));

  const brows = await db.select({
    vehicleId: bookings.vehicleId, status: bookings.status,
    startAt: bookings.startAt, endAt: bookings.endAt, priceBreakdown: bookings.priceBreakdown,
  }).from(bookings).where(inArray(bookings.status, ["pending", "confirmed", "completed"]));

  const rev = (b: (typeof brows)[number]) =>
    Number((b.priceBreakdown as { subtotalCents?: number } | null)?.subtotalCents ?? 0);
  const revenueRows = brows.filter((b) => (REVENUE_STATUSES as readonly string[]).includes(b.status));
  const occupancyRows = brows.filter((b) => (OCCUPANCY_STATUSES as readonly string[]).includes(b.status));

  const monthKey = today.slice(0, 7);
  const revenueAllCents = revenueRows.reduce((s, b) => s + rev(b), 0);
  const revenueMonthCents = revenueRows.filter((b) => arubaDateOf(b.startAt).slice(0, 7) === monthKey).reduce((s, b) => s + rev(b), 0);
  const rentalsThisMonth = brows.filter((b) => arubaDateOf(b.startAt).slice(0, 7) === monthKey).length;
  const activeRentals = brows.filter((b) => b.status === "confirmed" && arubaDateOf(b.startAt) <= today && arubaDateOf(b.endAt) > today).length;

  // Utilization over the next 30 days across the active fleet.
  const winStart = today, winEnd = addDays(today, 30);
  const bookedDaysByVehicle = new Map<string, number>();
  for (const b of occupancyRows) {
    const d = overlapDays(arubaDateOf(b.startAt), arubaDateOf(b.endAt), winStart, winEnd);
    if (d > 0) bookedDaysByVehicle.set(b.vehicleId, (bookedDaysByVehicle.get(b.vehicleId) ?? 0) + d);
  }
  const totalCarDays = activeVehicles.length * 30;
  const bookedDays = activeVehicles.reduce((s, v) => s + Math.min(30, bookedDaysByVehicle.get(v.id) ?? 0), 0);
  const utilizationPct = totalCarDays > 0 ? Math.round((bookedDays / totalCarDays) * 100) : 0;
  const idleCars = activeVehicles.filter((v) => !bookedDaysByVehicle.get(v.id)).length;

  // Revenue by month (last 6, chronological).
  const revenueByMonth = Array.from({ length: 6 }, (_, i) => monthOffset(today, 5 - i)).map((mk) => ({
    month: mk,
    cents: revenueRows.filter((b) => arubaDateOf(b.startAt).slice(0, 7) === mk).reduce((s, b) => s + rev(b), 0),
  }));

  // Revenue by class.
  const byClass = new Map<string, number>();
  for (const b of revenueRows) {
    const cls = vById.get(b.vehicleId)?.class ?? "Other";
    byClass.set(cls, (byClass.get(cls) ?? 0) + rev(b));
  }
  const revenueByClass = [...byClass.entries()].map(([cls, cents]) => ({ class: cls, cents })).sort((a, b) => b.cents - a.cents);

  // Top vehicles by revenue.
  const byVehicle = new Map<string, { cents: number; rentals: number }>();
  for (const b of revenueRows) {
    const cur = byVehicle.get(b.vehicleId) ?? { cents: 0, rentals: 0 };
    cur.cents += rev(b); cur.rentals += 1;
    byVehicle.set(b.vehicleId, cur);
  }
  const topVehicles = [...byVehicle.entries()]
    .map(([id, v]) => ({ plate: vById.get(id)?.plate ?? "?", name: vById.get(id)?.name ?? "?", cents: v.cents, rentals: v.rentals }))
    .sort((a, b) => b.cents - a.cents)
    .slice(0, 5);

  return {
    currency: settings.currency,
    month: monthKey,
    kpis: { revenueAllCents, revenueMonthCents, rentalsThisMonth, activeRentals, utilizationPct, idleCars },
    revenueByMonth, revenueByClass, topVehicles,
  };
}
