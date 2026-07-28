/**
 * Public, customer-facing read + quote helpers. Active records only, trimmed to
 * what the booking flow needs — no internal fields, no PII.
 */
import { eq, asc } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { vehicles, insuranceTiers, addOns } from "@/lib/db/schema";
import { getSettings } from "@/lib/admin/settings";
import { getLatestPolicy, type PolicyType } from "@/lib/admin/policies";
import { rentalDays, quote, type QuoteBreakdown } from "@/lib/booking/quote";
import { validateDates } from "@/lib/booking/availability";
import { atAruba, arubaNowIso } from "@/lib/time/format";
import { isoDate } from "@/lib/validation/iso-date";
import { Errors } from "@/lib/http/errors";

/** Rental start in Aruba local time (UTC-4), as YYYY-MM-DD. */
export function arubaToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Aruba" }).format(new Date());
}

/** Now as an Aruba fixed-offset ISO timestamp. Canonical impl lives in the time
 *  module; re-exported here for the booking routes that already import it. */
export { arubaNowIso };

/** Boundary compat: a bare YYYY-MM-DD (Phase 1 deep links, old clients) becomes
 *  that date at the shop's opening time, Aruba. Full timestamps pass through
 *  unchanged. */
export function normalizeTs(value: string, openingTime: string): string {
  return isoDate.safeParse(value).success ? atAruba(value, openingTime) : value;
}

/** Legacy-key compat: not-yet-updated clients (the Phase 1 site, the ops
 *  board before Task 5) post startDate/endDate; map those onto startAt/endAt
 *  before schema validation so old and new field names both work. */
export function mapLegacyDateKeys(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const obj = { ...(raw as Record<string, unknown>) };
  if (obj.startDate !== undefined && obj.startAt === undefined) obj.startAt = obj.startDate;
  if (obj.endDate !== undefined && obj.endAt === undefined) obj.endAt = obj.endDate;
  delete obj.startDate;
  delete obj.endDate;
  return obj;
}

export interface PublicVehicle {
  slug: string; class: string; name: string; seats: number;
  transmission: string; ac: boolean; doors: number; photos: string[];
  priceDayCents: number; priceWeekCents: number; priceMonthCents: number; depositCents: number | null;
}

export async function publicVehicles(): Promise<PublicVehicle[]> {
  const db = await getDb();
  const rows = await db.select().from(vehicles).where(eq(vehicles.status, "active")).orderBy(asc(vehicles.class), asc(vehicles.priceDayCents));
  return rows.map((v) => ({
    slug: v.slug, class: v.class, name: v.name, seats: v.seats, transmission: v.transmission,
    ac: v.ac, doors: v.doors, photos: v.photos, priceDayCents: v.priceDayCents,
    priceWeekCents: v.priceWeekCents, priceMonthCents: v.priceMonthCents, depositCents: v.depositCents,
  }));
}

export async function publicInsurance() {
  const db = await getDb();
  const rows = await db.select().from(insuranceTiers).where(eq(insuranceTiers.active, true)).orderBy(asc(insuranceTiers.dailyPriceCents));
  return rows.map((t) => ({ id: t.id, name: t.name, dailyPriceCents: t.dailyPriceCents, coverage: t.coverage, isDefault: t.isDefault }));
}

export async function publicAddOns() {
  const db = await getDb();
  const rows = await db.select().from(addOns).where(eq(addOns.active, true)).orderBy(asc(addOns.category), asc(addOns.name));
  return rows.map((a) => ({ id: a.id, name: a.name, description: a.description, priceCents: a.priceCents, pricing: a.pricing, category: a.category }));
}

export async function publicPolicy(type: PolicyType) {
  const latest = await getLatestPolicy(type);
  if (!latest) return null;
  return { type, version: latest.version, body: latest.body, publishedAt: latest.publishedAt };
}

export interface QuoteRequest {
  vehicleSlug: string;
  startAt: string;
  endAt: string;
  insuranceTierId?: string | null;
  addOns?: Array<{ addOnId: string; qty: number }>;
  /** Claimed age band from the wizard selector; drives the live quote only.
   *  createBooking re-derives the truth from the licence DOB. */
  youngDriver?: boolean;
}

/** Policy facts alongside the quote: what the customer can rely on when
 *  deciding how to pay. The security deposit here is the vehicle's BORG — an
 *  at-pickup, refundable info line, never charged online. */
export interface QuotePolicy {
  cancellationWindowHours: number;
  securityDepositCents: number | null;
}

/** Validate + price a request without creating anything. Throws 4xx on bad input. */
export async function publicQuote(req: QuoteRequest, nowIso: string): Promise<QuoteBreakdown & { policy: QuotePolicy }> {
  const db = await getDb();
  const settings = await getSettings();
  const [vehicle] = await db.select().from(vehicles).where(eq(vehicles.slug, req.vehicleSlug));
  if (!vehicle || vehicle.status !== "active") throw Errors.notFound("Vehicle not available");
  validateDates(req.startAt, req.endAt, settings, nowIso);

  let insurance: { id: string; name: string; dailyPriceCents: number } | null = null;
  if (req.insuranceTierId) {
    const [tier] = await db.select().from(insuranceTiers).where(eq(insuranceTiers.id, req.insuranceTierId));
    if (tier && tier.active) insurance = { id: tier.id, name: tier.name, dailyPriceCents: tier.dailyPriceCents };
  }

  const reqAddOns = req.addOns ?? [];
  const addOnRows = reqAddOns.length
    ? await db.select().from(addOns).where(eq(addOns.active, true))
    : [];
  const byId = new Map(addOnRows.map((a) => [a.id, a]));

  const breakdown = quote({
    days: rentalDays(req.startAt, req.endAt),
    vehicle: {
      priceDayCents: vehicle.priceDayCents, priceWeekCents: vehicle.priceWeekCents,
      priceMonthCents: vehicle.priceMonthCents, depositCents: vehicle.depositCents,
    },
    insurance,
    addOns: reqAddOns.flatMap((r) => {
      const a = byId.get(r.addOnId);
      return a ? [{ id: a.id, name: a.name, priceCents: a.priceCents, pricing: a.pricing, qty: r.qty }] : [];
    }),
    depositPercent: settings.depositPercent,
    depositMinCents: settings.depositMinCents,
    currency: settings.currency,
    youngDriver: req.youngDriver ?? false,
    youngDriverFeeCentsPerDay: settings.youngDriverFeeCentsPerDay,
  });

  return {
    ...breakdown,
    policy: {
      cancellationWindowHours: settings.cancellationWindowHours,
      securityDepositCents: vehicle.depositCents,
    },
  };
}

export interface PublicBookingConfig {
  minDriverAge: number;
  youngDriverAge: number;
  youngDriverFeeCentsPerDay: number;
  currency: string;
  /** The operator's actual pick-up/return window ("HH:MM"), so the wizard's
   *  time pickers never offer a slot the quote will then reject. */
  openingTime: string;
  closingTime: string;
}

/** Non-sensitive booking settings the wizard needs before it can quote
 *  (workstream 5: the driver-age selector labels derive from these; the
 *  opening/closing hours seed the Dates step's TimeSelect min/max so an
 *  operator with custom hours never has out-of-hours slots offered). */
export async function publicBookingConfig(): Promise<PublicBookingConfig> {
  const s = await getSettings();
  return {
    minDriverAge: s.minDriverAge,
    youngDriverAge: s.youngDriverAge,
    youngDriverFeeCentsPerDay: s.youngDriverFeeCentsPerDay,
    currency: s.currency,
    openingTime: s.openingTime,
    closingTime: s.closingTime,
  };
}
