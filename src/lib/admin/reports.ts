/**
 * Owner-facing numbers for the Reports page. Aggregated in JS (not SQL) because
 * the fleet is small and it keeps the booking JSON math identical across the
 * PGlite (dev) and Postgres (prod) drivers. "Revenue" = the rental subtotal
 * snapshotted on each confirmed/completed booking (priceBreakdown.subtotalCents);
 * cancelled bookings never count.
 */
import { inArray, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { vehicles, bookings, inspections } from "@/lib/db/schema";
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

const REVENUE_STATUSES = ["confirmed", "picked_up", "completed"] as const;
const OCCUPANCY_STATUSES = ["pending", "confirmed", "picked_up"] as const;

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
  }).from(bookings).where(inArray(bookings.status, ["pending", "confirmed", "picked_up", "completed"]));

  const rev = (b: (typeof brows)[number]) =>
    Number((b.priceBreakdown as { subtotalCents?: number } | null)?.subtotalCents ?? 0);
  const revenueRows = brows.filter((b) => (REVENUE_STATUSES as readonly string[]).includes(b.status));
  const occupancyRows = brows.filter((b) => (OCCUPANCY_STATUSES as readonly string[]).includes(b.status));

  const monthKey = today.slice(0, 7);
  const revenueAllCents = revenueRows.reduce((s, b) => s + rev(b), 0);
  const revenueMonthCents = revenueRows.filter((b) => arubaDateOf(b.startAt).slice(0, 7) === monthKey).reduce((s, b) => s + rev(b), 0);
  const rentalsThisMonth = brows.filter((b) => arubaDateOf(b.startAt).slice(0, 7) === monthKey).length;
  const activeRentals = brows.filter((b) => (b.status === "confirmed" || b.status === "picked_up") && arubaDateOf(b.startAt) <= today && arubaDateOf(b.endAt) > today).length;

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

/* ---------------------------------------------------------------------------
 * Per-car revenue matrix (wave 07). Rows = vehicles grouped by class, columns
 * = the 12 months of `year`. A booking's snapshot subtotal is sliced across
 * months by overlap DAYS (Aruba local), allocated cumulatively so rounding
 * never drifts: a fully-in-year booking's cells sum exactly to its subtotal.
 * Revenue = rental income snapshots only; payment rows (including historical
 * pre-wave deposit charges) are never read. The borg summary reports security
 * deposits separately because deposits are held money, never revenue.
 * ------------------------------------------------------------------------- */

export interface PerCarRow {
  vehicleId: string;
  name: string;
  plate: string;
  class: string;
  monthCents: number[]; // 12 entries, January first
  totalCents: number;
}

export interface BorgWithheldItem {
  plate: string;
  name: string;
  amountCents: number;
  reason: string;
}

export interface PerCarRevenueReport {
  year: number;
  months: string[]; // ["YYYY-01", ..., "YYYY-12"]
  rows: PerCarRow[];
  grandTotalCents: number;
  borg: {
    heldCents: number;
    returnedCents: number;
    withheldCents: number;
    withheldCount: number;
    withheldItems: BorgWithheldItem[]; // additive plan-07 field (spec: withheld amounts WITH reasons)
  };
}

/** Fleet grouping order for report rows. Kept module-local on purpose: the
 *  seams doc defines no shared CLASS_ORDER export and plan 04 groups the fleet
 *  page with its own copy. Unknown classes sort last, then by plate. */
const REPORT_CLASS_ORDER = ["Economy", "Compact", "SUV", "4x4", "Van"];

/** The calendar day of a timestamp where the business operates (America/Aruba). */
const arubaDay = (d: Date | string): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Aruba" }).format(new Date(d));

export async function perCarRevenue(year: number): Promise<PerCarRevenueReport> {
  const db = await getDb();

  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
  const monthStarts = months.map((mk) => `${mk}-01`);
  const monthEnds = months.map((_, i) =>
    i === 11 ? `${year + 1}-01-01` : `${year}-${String(i + 2).padStart(2, "0")}-01`);

  const vrows = await db.select({
    id: vehicles.id, plate: vehicles.plate, name: vehicles.name, class: vehicles.class, status: vehicles.status,
  }).from(vehicles);
  const vById = new Map(vrows.map((v) => [v.id, v]));

  const brows = await db.select({
    vehicleId: bookings.vehicleId, startAt: bookings.startAt, endAt: bookings.endAt,
    priceBreakdown: bookings.priceBreakdown,
  }).from(bookings).where(inArray(bookings.status, ["confirmed", "picked_up", "completed"]));

  const cells = new Map<string, number[]>();
  for (const b of brows) {
    const subtotal = Number((b.priceBreakdown as { subtotalCents?: number } | null)?.subtotalCents ?? 0);
    if (subtotal <= 0) continue;
    const startDay = arubaDay(b.startAt);
    let endDay = arubaDay(b.endAt);
    if (endDay <= startDay) endDay = addDays(startDay, 1); // sub-24h rental = one day
    const totalDays = Math.round((Date.parse(`${endDay}T00:00:00Z`) - Date.parse(`${startDay}T00:00:00Z`)) / 86_400_000);

    let arr = cells.get(b.vehicleId);
    if (!arr) { arr = new Array<number>(12).fill(0); cells.set(b.vehicleId, arr); }
    let cumDays = 0;
    let allocated = 0;
    for (let m = 0; m < 12; m++) {
      cumDays += overlapDays(startDay, endDay, monthStarts[m]!, monthEnds[m]!);
      const target = Math.round((subtotal * cumDays) / totalDays);
      arr[m] = arr[m]! + (target - allocated);
      allocated = target;
    }
  }

  const rows: PerCarRow[] = vrows
    .filter((v) => v.status !== "retired" || (cells.get(v.id)?.some((c) => c > 0) ?? false))
    .map((v) => {
      const monthCents = cells.get(v.id) ?? new Array<number>(12).fill(0);
      return {
        vehicleId: v.id, name: v.name, plate: v.plate, class: v.class,
        monthCents, totalCents: monthCents.reduce((s, c) => s + c, 0),
      };
    })
    .sort((a, b) => {
      const ia = REPORT_CLASS_ORDER.indexOf(a.class), ib = REPORT_CLASS_ORDER.indexOf(b.class);
      const d = (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      return d !== 0 ? d : a.plate.localeCompare(b.plate);
    });
  const grandTotalCents = rows.reduce((s, r) => s + r.totalCents, 0);

  // Borg (security deposits) from check-in / check-out inspections this year.
  const irows = await db.select({
    kind: inspections.kind,
    createdAt: inspections.createdAt,
    borgReceivedCents: inspections.borgReceivedCents,
    borgReturnedCents: inspections.borgReturnedCents,
    borgWithheldCents: inspections.borgWithheldCents,
    borgWithheldReason: inspections.borgWithheldReason,
    vehicleId: bookings.vehicleId,
  }).from(inspections).innerJoin(bookings, eq(inspections.bookingId, bookings.id));

  let heldCents = 0, returnedCents = 0, withheldCents = 0, withheldCount = 0;
  const withheldItems: BorgWithheldItem[] = [];
  for (const insp of irows) {
    if (arubaDay(insp.createdAt).slice(0, 4) !== String(year)) continue;
    if (insp.kind === "pickup") {
      heldCents += insp.borgReceivedCents ?? 0;
    } else {
      returnedCents += insp.borgReturnedCents ?? 0;
      const w = insp.borgWithheldCents ?? 0;
      if (w > 0) {
        withheldCents += w;
        withheldCount += 1;
        const v = vById.get(insp.vehicleId);
        withheldItems.push({
          plate: v?.plate ?? "?", name: v?.name ?? "?",
          amountCents: w, reason: insp.borgWithheldReason ?? "",
        });
      }
    }
  }

  return { year, months, rows, grandTotalCents, borg: { heldCents, returnedCents, withheldCents, withheldCount, withheldItems } };
}
