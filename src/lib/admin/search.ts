import { z } from "zod";
import { and, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { bookings, customers, vehicles } from "@/lib/db/schema";
import { ARUBA_TZ, parseTs } from "@/lib/time/format";

/**
 * Desk search: find a customer or a rental by what the desk has in hand.
 * One box matches customer name, email, phone (digits only, so "+599 717"
 * finds "599-7171234"), plate (spaces and dashes ignored), vehicle name and
 * the first characters of a booking id. Results come back grouped per
 * customer, the rental that matters most first.
 */
export const SearchQuerySchema = z.object({
  q: z.string().trim().min(2).max(80),
});

export interface SearchBooking {
  id: string;
  plate: string;
  vehicleName: string;
  dates: string;
  status: string;
  statusLabel: string;
}

export interface SearchCustomer {
  id: string;
  name: string;
  email: string;
  phone: string;
  rentals: number;
  bookings: SearchBooking[];
}

export interface SearchResult {
  customers: SearchCustomer[];
}

const MAX_ROWS = 80;
const MAX_CUSTOMERS = 8;
const MAX_BOOKINGS_PER_CUSTOMER = 5;

export const SEARCH_STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  confirmed: "Confirmed",
  picked_up: "With customer",
  cancelled: "Cancelled",
  completed: "Returned",
};

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

const dayFmt = new Intl.DateTimeFormat("en-GB", { timeZone: ARUBA_TZ, day: "numeric", month: "short" });
const yearFmt = new Intl.DateTimeFormat("en-GB", { timeZone: ARUBA_TZ, year: "numeric" });

/** "12 Nov to 15 Nov", with the year added when it is not this year. */
export function searchDates(startAt: string, endAt: string, now = new Date()): string {
  const s = new Date(parseTs(startAt));
  const e = new Date(parseTs(endAt));
  const thisYear = yearFmt.format(now);
  const day = (d: Date) => {
    const y = yearFmt.format(d);
    return y === thisYear ? dayFmt.format(d) : `${dayFmt.format(d)} ${y}`;
  };
  const a = day(s);
  const b = day(e);
  return a === b ? a : `${a} to ${b}`;
}

/**
 * Lower rank shows first: with the customer now, then upcoming (soonest
 * first), then past (latest first), cancelled last.
 */
export function bookingRank(status: string, startAt: string, endAt: string, nowMs = Date.now()): number {
  const start = parseTs(startAt);
  const end = parseTs(endAt);
  if (status === "picked_up") return 0;
  if (status === "cancelled") return 4e15 - start / 1000;
  if (end >= nowMs) return 1e15 + start / 1000;
  return 2e15 - start / 1000;
}

export async function searchDesk(rawQ: string, now = new Date()): Promise<SearchResult> {
  const q = rawQ.trim();
  const db = await getDb();
  const pattern = `%${likeEscape(q)}%`;
  const digits = q.replace(/\D/g, "");
  const alnum = q.replace(/[^a-z0-9]/gi, "");

  const conds: SQL[] = [
    ilike(customers.name, pattern),
    ilike(customers.email, pattern),
    ilike(vehicles.name, pattern),
    ilike(vehicles.plate, pattern),
  ];
  if (digits.length >= 3) {
    conds.push(sql`regexp_replace(${customers.phone}, '[^0-9]', '', 'g') like ${`%${digits}%`}`);
  }
  if (alnum.length >= 2) {
    conds.push(sql`regexp_replace(${vehicles.plate}, '[^A-Za-z0-9]', '', 'g') ilike ${`%${alnum}%`}`);
  }
  if (/^[0-9a-f-]{4,36}$/i.test(q)) {
    conds.push(sql`${bookings.id}::text ilike ${`${likeEscape(q.toLowerCase())}%`}`);
  }

  const rows = await db
    .select({
      bookingId: bookings.id,
      startAt: bookings.startAt,
      endAt: bookings.endAt,
      status: bookings.status,
      customerId: customers.id,
      name: customers.name,
      email: customers.email,
      phone: customers.phone,
      plate: vehicles.plate,
      vehicleName: vehicles.name,
    })
    .from(bookings)
    .innerJoin(customers, eq(bookings.customerId, customers.id))
    .innerJoin(vehicles, eq(bookings.vehicleId, vehicles.id))
    .where(and(or(...conds)))
    .orderBy(desc(bookings.startAt))
    .limit(MAX_ROWS);

  const nowMs = now.getTime();
  type Group = SearchCustomer & { best: number; ranked: Array<{ rank: number; b: SearchBooking }> };
  const groups = new Map<string, Group>();
  for (const r of rows) {
    let g = groups.get(r.customerId);
    if (!g) {
      g = { id: r.customerId, name: r.name, email: r.email, phone: r.phone, rentals: 0, bookings: [], best: Infinity, ranked: [] };
      groups.set(r.customerId, g);
    }
    const rank = bookingRank(r.status, r.startAt, r.endAt, nowMs);
    g.rentals += 1;
    g.best = Math.min(g.best, rank);
    g.ranked.push({
      rank,
      b: {
        id: r.bookingId,
        plate: r.plate,
        vehicleName: r.vehicleName,
        dates: searchDates(r.startAt, r.endAt, now),
        status: r.status,
        statusLabel: SEARCH_STATUS_LABEL[r.status] ?? r.status,
      },
    });
  }

  const ordered = [...groups.values()].sort((a, b) => a.best - b.best).slice(0, MAX_CUSTOMERS);
  return {
    customers: ordered.map(({ id, name, email, phone, rentals, ranked }) => ({
      id, name, email, phone, rentals,
      bookings: ranked.sort((a, b) => a.rank - b.rank).slice(0, MAX_BOOKINGS_PER_CUSTOMER).map((x) => x.b),
    })),
  };
}
